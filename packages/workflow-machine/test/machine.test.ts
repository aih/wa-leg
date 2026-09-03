import { describe, expect, it } from 'vitest';
import {
  EVENT_LABELS,
  EVENT_TYPES,
  STATE_HINTS,
  STATE_LABELS,
  TRANSITIONS,
  WORKFLOW_STATES,
  availableEvents,
  isDrafter,
  isEditable,
  isFinal,
  isReviewer,
  transition,
  type Actor,
  type Ctx,
  type EventType,
  type WorkflowState,
} from '../src/index.js';

const dana: Actor = { userId: 'dev-drafter', roles: ['drafter'] };
const rae: Actor = { userId: 'dev-reviewer', roles: ['reviewer'] };
const cam: Actor = { userId: 'dev-committee', roles: ['viewer'] };
const jordan: Actor = { userId: 'dev-both', roles: ['drafter', 'reviewer'] };
const system: Actor = { userId: 'system', roles: ['admin'] };
const actors = { dana, rae, cam, jordan, system };

const fresh = (): Ctx => ({ drafterId: 'dev-drafter', reviewerId: null });

describe('transition table', () => {
  it('lists five states and four events', () => {
    expect(WORKFLOW_STATES).toEqual(['draft', 'in_review', 'changes_requested', 'approved', 'published']);
    expect(EVENT_TYPES).toEqual(['SUBMIT', 'REQUEST_CHANGES', 'APPROVE', 'PUBLISH']);
    for (const s of WORKFLOW_STATES) {
      expect(STATE_LABELS[s]).toBeTruthy();
      expect(STATE_HINTS[s]).toBeTruthy();
    }
    for (const e of EVENT_TYPES) expect(EVENT_LABELS[e]).toBeTruthy();
  });

  it('runs the path: submit, request changes, resubmit, approve, publish', () => {
    let ctx = fresh();
    let r = transition('draft', 'SUBMIT', dana, ctx);
    expect(r.ok && r.state).toBe('in_review');
    r = transition('in_review', 'REQUEST_CHANGES', rae, ctx, { message: 'Fix the totals' });
    expect(r.ok && r.state).toBe('changes_requested');
    if (r.ok) ctx = r.ctx;
    expect(ctx.reviewerId).toBe('dev-reviewer');
    r = transition('changes_requested', 'SUBMIT', dana, ctx, { message: 'Totals fixed' });
    expect(r.ok && r.state).toBe('in_review');
    r = transition('in_review', 'APPROVE', rae, ctx);
    expect(r.ok && r.state).toBe('approved');
    r = transition('approved', 'PUBLISH', rae, ctx);
    expect(r.ok && r.state).toBe('published');
  });

  it('the first review action sets the reviewer and later ones keep it', () => {
    const first = transition('in_review', 'APPROVE', jordan, fresh());
    expect(first.ok && first.ctx.reviewerId).toBe('dev-both');
    const later = transition('approved', 'PUBLISH', rae, { drafterId: 'dev-drafter', reviewerId: 'dev-both' });
    expect(later.ok && later.ctx.reviewerId).toBe('dev-both');
    const ctx = fresh();
    transition('in_review', 'APPROVE', rae, ctx);
    expect(ctx.reviewerId).toBeNull();
  });

  it('REQUEST_CHANGES needs a message', () => {
    for (const message of [undefined, null, '', '   ']) {
      const r = transition('in_review', 'REQUEST_CHANGES', rae, fresh(), { message });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe('message_required');
    }
    expect(transition('in_review', 'REQUEST_CHANGES', rae, fresh(), { message: 'x' }).ok).toBe(true);
    for (const [state, event] of [['draft', 'SUBMIT'], ['in_review', 'APPROVE'], ['approved', 'PUBLISH']] as const) {
      expect(transition(state, event, state === 'draft' ? dana : rae, fresh()).ok).toBe(true);
    }
  });

  it('refuses unknown events and events not in the table for the state', () => {
    const unknown = transition('draft', 'CANCEL' as EventType, rae, fresh());
    expect(!unknown.ok && unknown.reason).toBe('unknown_event');
    const wrong = transition('draft', 'APPROVE', rae, fresh());
    expect(!wrong.ok && wrong.reason).toBe('not_in_state');
    expect(!wrong.ok && wrong.message).toMatch(/not available while the note is draft/);
  });

  it('nothing is available in published', () => {
    for (const a of Object.values(actors)) {
      expect(availableEvents('published', a, { drafterId: 'dev-drafter', reviewerId: 'dev-reviewer' })).toEqual([]);
      for (const e of EVENT_TYPES) expect(transition('published', e, a, fresh()).ok).toBe(false);
    }
    expect(isFinal('published')).toBe(true);
    expect(WORKFLOW_STATES.filter(isFinal)).toEqual(['published']);
  });

  it('every state, event and actor: the table decides', () => {
    const expected: Record<WorkflowState, Partial<Record<keyof typeof actors, EventType[]>>> = {
      draft: { dana: ['SUBMIT'] },
      in_review: { rae: ['REQUEST_CHANGES', 'APPROVE'], jordan: ['REQUEST_CHANGES', 'APPROVE'] },
      changes_requested: { dana: ['SUBMIT'] },
      approved: { rae: ['PUBLISH'], jordan: ['PUBLISH'] },
      published: {},
    };
    for (const state of WORKFLOW_STATES) {
      for (const [name, actor] of Object.entries(actors) as [keyof typeof actors, Actor][]) {
        const want = expected[state][name] ?? [];
        expect(availableEvents(state, actor, fresh()), `${state} ${name}`).toEqual(want);
        for (const event of EVENT_TYPES) {
          const r = transition(state, event, actor, fresh(), { message: 'm' });
          expect(r.ok, `${state} ${event} ${name}`).toBe(want.includes(event));
          if (r.ok) expect(r.state).toBe(TRANSITIONS.find((t) => t.from === state && t.event === event)!.to);
        }
      }
    }
  });

  it('the drafter cannot review their own note even with the reviewer role', () => {
    const own: Ctx = { drafterId: 'dev-both', reviewerId: null };
    expect(availableEvents('in_review', jordan, own)).toEqual([]);
    expect(availableEvents('approved', jordan, own)).toEqual([]);
    expect(availableEvents('draft', jordan, own)).toEqual(['SUBMIT']);
    const r = transition('in_review', 'APPROVE', jordan, own);
    expect(!r.ok && r.reason).toBe('not_allowed');
    expect(isDrafter(jordan, own)).toBe(true);
    expect(isReviewer(jordan, own)).toBe(false);
    expect(isReviewer(rae, own)).toBe(true);
    expect(isReviewer(cam, own)).toBe(false);
    expect(isReviewer(system, own)).toBe(false);
  });

  it('a drafter other than the assigned one is refused', () => {
    const other: Actor = { userId: 'someone', roles: ['drafter'] };
    const r = transition('draft', 'SUBMIT', other, fresh());
    expect(!r.ok && r.reason).toBe('not_allowed');
    expect(availableEvents('draft', other, fresh())).toEqual([]);
    expect(transition('draft', 'SUBMIT', dana, { drafterId: null, reviewerId: null }).ok).toBe(false);
  });

  it('the drafter edits in draft and changes_requested only', () => {
    expect(WORKFLOW_STATES.filter(isEditable)).toEqual(['draft', 'changes_requested']);
  });
});
