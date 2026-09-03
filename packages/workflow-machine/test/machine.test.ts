import { describe, expect, it } from 'vitest';
import {
  availableEvents,
  can,
  initialSnapshot,
  step,
  stateOf,
  NotAllowedError,
  BUTTON_EVENTS,
  drafterStatus,
  reviewerStatus,
  flattenState,
  expandState,
  type Actor,
} from '../src/index.js';

const drafter: Actor = { userId: 'u-drafter', roles: ['drafter'] };
const other: Actor = { userId: 'u-other', roles: ['drafter'] };
const editor: Actor = { userId: 'u-editor', roles: ['editor', 'manager'] };
const editor2: Actor = { userId: 'u-editor2', roles: ['editor', 'manager'] };
const exec1: Actor = { userId: 'u-exec1', roles: ['executive'] };
const exec2: Actor = { userId: 'u-exec2', roles: ['executive'] };
const system: Actor = { userId: 'system', roles: ['system'] };

function fresh() {
  return initialSnapshot({ noteRevisionId: 'r1', billVersionId: 'WA:2025-26:HB2402/S', drafterId: 'u-drafter' });
}

describe('fiscal note machine', () => {
  it('starts in todo with the drafter from input', () => {
    const s = fresh();
    expect(stateOf(s)).toBe('todo');
    expect(s.context.drafterId).toBe('u-drafter');
  });

  it('runs the happy path: start, submit, claim, approve', () => {
    let s: unknown = fresh();
    s = step(s, { type: 'START', actor: drafter }).snapshot;
    expect(stateOf(s)).toBe('in_progress');
    s = step(s, { type: 'SUBMIT_FOR_REVIEW', actor: drafter }).snapshot;
    expect(stateOf(s)).toBe('review.pending');
    const claimed = step(s, { type: 'CLAIM_REVIEW', actor: editor });
    expect(claimed.state).toBe('review.active');
    expect(claimed.context.reviewerId).toBe('u-editor');
    const approved = step(claimed.snapshot, { type: 'APPROVE', actor: editor });
    expect(approved.state).toBe('approved');
    expect(approved.actions.map((a) => a.type)).toContain('emit');
  });

  it('request changes returns to the drafter and resubmission re-enters review', () => {
    let s: unknown = fresh();
    s = step(s, { type: 'START', actor: drafter }).snapshot;
    s = step(s, { type: 'SUBMIT_FOR_REVIEW', actor: drafter }).snapshot;
    s = step(s, { type: 'CLAIM_REVIEW', actor: editor }).snapshot;
    s = step(s, { type: 'REQUEST_CHANGES', actor: editor, comment: 'fix totals' }).snapshot;
    expect(stateOf(s)).toBe('changes_requested');
    expect(can(s, 'SUBMIT_FOR_REVIEW', drafter)).toBe(true);
    expect(can(s, 'SUBMIT_FOR_REVIEW', other)).toBe(false);
    s = step(s, { type: 'SUBMIT_FOR_REVIEW', actor: drafter }).snapshot;
    expect(stateOf(s)).toBe('review.pending');
    // the reviewer is remembered, so only that reviewer may claim again
    expect(can(s, 'CLAIM_REVIEW', editor)).toBe(true);
    expect(can(s, 'CLAIM_REVIEW', editor2)).toBe(false);
  });

  it('only the drafter can start; others are refused', () => {
    const s = fresh();
    expect(can(s, 'START', drafter)).toBe(true);
    expect(can(s, 'START', other)).toBe(false);
    expect(can(s, 'START', editor)).toBe(false);
    expect(() => step(s, { type: 'START', actor: other })).toThrow(NotAllowedError);
  });

  it('a two-step executive chain notifies each step and approves at the end', () => {
    let s: unknown = fresh();
    s = step(s, {
      type: 'SET_EXEC_CHAIN',
      actor: editor,
      chain: [
        { userId: 'u-exec1', division: 'RFA', dueAt: null, doneAt: null },
        { userId: 'u-exec2', division: 'Budget', dueAt: null, doneAt: null },
      ],
    }).snapshot;
    s = step(s, { type: 'START', actor: drafter }).snapshot;
    s = step(s, { type: 'SUBMIT_FOR_REVIEW', actor: drafter }).snapshot;
    s = step(s, { type: 'CLAIM_REVIEW', actor: editor }).snapshot;
    const r1 = step(s, { type: 'APPROVE', actor: editor });
    expect(r1.state).toBe('exec_review.pending');
    expect(r1.actions).toContainEqual({ type: 'notify', params: { to: 'currentExec' } });
    expect(can(r1.snapshot, 'EXEC_CLAIM', exec1)).toBe(true);
    expect(can(r1.snapshot, 'EXEC_CLAIM', exec2)).toBe(false);
    s = step(r1.snapshot, { type: 'EXEC_CLAIM', actor: exec1 }).snapshot;
    const r2 = step(s, { type: 'EXEC_DONE', actor: exec1 });
    expect(r2.state).toBe('exec_review.pending');
    expect(r2.context.execIndex).toBe(1);
    expect(r2.context.execChain[0]?.doneAt).toBeTruthy();
    expect(r2.actions).toContainEqual({ type: 'notify', params: { to: 'currentExec' } });
    expect(can(r2.snapshot, 'EXEC_CLAIM', exec1)).toBe(false);
    s = step(r2.snapshot, { type: 'EXEC_CLAIM', actor: exec2 }).snapshot;
    const r3 = step(s, { type: 'EXEC_DONE', actor: exec2 });
    expect(r3.state).toBe('approved');
  });

  it('EXEC_RETURN resets the chain and goes to changes_requested', () => {
    let s: unknown = fresh();
    s = step(s, {
      type: 'SET_EXEC_CHAIN',
      actor: editor,
      chain: [{ userId: 'u-exec1', division: 'RFA', dueAt: null, doneAt: null }],
    }).snapshot;
    s = step(s, { type: 'START', actor: drafter }).snapshot;
    s = step(s, { type: 'SUBMIT_FOR_REVIEW', actor: drafter }).snapshot;
    s = step(s, { type: 'CLAIM_REVIEW', actor: editor }).snapshot;
    s = step(s, { type: 'APPROVE', actor: editor }).snapshot;
    s = step(s, { type: 'EXEC_CLAIM', actor: exec1 }).snapshot;
    const r = step(s, { type: 'EXEC_RETURN', actor: exec1, comment: 'no' });
    expect(r.state).toBe('changes_requested');
    expect(r.context.execIndex).toBe(0);
  });

  it('SUPERSEDE is only for the system and works from any non-final state', () => {
    let s: unknown = fresh();
    expect(can(s, 'SUPERSEDE', editor)).toBe(false);
    expect(can(s, 'SUPERSEDE', system)).toBe(true);
    s = step(s, { type: 'START', actor: drafter }).snapshot;
    s = step(s, { type: 'SUBMIT_FOR_REVIEW', actor: drafter }).snapshot;
    const r = step(s, { type: 'SUPERSEDE', actor: system, newBillVersionId: 'x' });
    expect(r.state).toBe('superseded');
    expect(can(r.snapshot, 'SUPERSEDE', system)).toBe(false);
    expect(can(r.snapshot, 'CANCEL', editor)).toBe(false);
  });

  it('managers can cancel, reassign and set the chain; drafters cannot', () => {
    const s = fresh();
    expect(can(s, 'CANCEL', editor)).toBe(true);
    expect(can(s, 'CANCEL', drafter)).toBe(false);
    expect(can(s, 'REASSIGN', editor)).toBe(true);
    expect(can(s, 'REASSIGN', drafter)).toBe(false);
    const r = step(s, { type: 'REASSIGN', actor: editor, role: 'drafter', userId: 'u-other' });
    expect(r.context.drafterId).toBe('u-other');
    expect(can(r.snapshot, 'START', other)).toBe(true);
    expect(can(r.snapshot, 'START', drafter)).toBe(false);
  });

  it('availableEvents lists only the buttons the caller may press', () => {
    let s: unknown = fresh();
    expect(availableEvents(s, drafter, BUTTON_EVENTS)).toEqual(['START']);
    expect(availableEvents(s, editor, BUTTON_EVENTS)).toEqual(['CANCEL']);
    s = step(s, { type: 'START', actor: drafter }).snapshot;
    s = step(s, { type: 'SUBMIT_FOR_REVIEW', actor: drafter }).snapshot;
    expect(availableEvents(s, drafter, BUTTON_EVENTS)).toEqual([]);
    expect(availableEvents(s, editor, BUTTON_EVENTS)).toEqual(['CLAIM_REVIEW', 'CANCEL']);
  });

  it('round-trips a persisted snapshot through JSON', () => {
    let s: unknown = fresh();
    s = step(s, { type: 'START', actor: drafter }).snapshot;
    const json = JSON.parse(JSON.stringify(s));
    expect(stateOf(json)).toBe('in_progress');
    expect(can(json, 'SUBMIT_FOR_REVIEW', drafter)).toBe(true);
    // and from the flattened { state, context } form
    expect(stateOf({ state: 'review.pending', context: (json as any).context })).toBe('review.pending');
  });

  it('maps states to role vocabularies', () => {
    expect(drafterStatus('review.pending')).toBe('ready-for-review');
    expect(drafterStatus('changes_requested')).toBe('address-review');
    expect(reviewerStatus('review.pending')).toBe('pending');
    expect(reviewerStatus('review.active')).toBe('in-review');
    expect(reviewerStatus('changes_requested')).toBe('changes-requested');
    expect(flattenState({ review: 'active' })).toBe('review.active');
    expect(expandState('exec_review.pending')).toEqual({ exec_review: 'pending' });
    expect(expandState('todo')).toBe('todo');
  });
});
