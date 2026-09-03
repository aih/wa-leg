import { describe, expect, it } from 'vitest';
import { can, toActor, type NoteResource } from '../src/modules/identity/index.js';
import { users } from './helpers.js';

const note = (over: Partial<NoteResource> = {}): NoteResource => ({
  type: 'note',
  state: 'in_progress',
  drafterId: 'dev-drafter',
  reviewerId: null,
  execChain: [],
  execIndex: 0,
  confidential: false,
  division: 'RFA',
  ...over,
});

const { drafter, drafter2, otherDivDrafter, reviewer, reviewer2, approver, manager, viewer, templateEditor, admin, both, execBudget } = users;

describe('can(): permission matrix', () => {
  it('bills and templates are readable by everyone', () => {
    for (const p of Object.values(users)) {
      expect(can(p, 'bill.read')).toBe(true);
      expect(can(p, 'template.read')).toBe(true);
    }
  });

  it('template.edit is the template-editor role (and admin)', () => {
    expect(can(templateEditor, 'template.edit')).toBe(true);
    expect(can(admin, 'template.edit')).toBe(true);
    expect(can(reviewer, 'template.edit')).toBe(false);
    expect(can(drafter, 'template.edit')).toBe(false);
  });

  it('ingest.run and search.reindex are admin only', () => {
    expect(can(admin, 'ingest.run')).toBe(true);
    expect(can(admin, 'search.reindex')).toBe(true);
    for (const p of [drafter, reviewer, manager, approver, viewer]) {
      expect(can(p, 'ingest.run')).toBe(false);
      expect(can(p, 'search.reindex')).toBe(false);
    }
  });

  it('note.create: reviewer (assigner), admin; drafter only for self-assigned estimates', () => {
    expect(can(reviewer, 'note.create', { type: 'note.create', kind: 'note' })).toBe(true);
    expect(can(manager, 'note.create', { type: 'note.create', kind: 'note' })).toBe(true);
    expect(can(admin, 'note.create', { type: 'note.create', kind: 'note' })).toBe(true);
    expect(can(drafter, 'note.create', { type: 'note.create', kind: 'note' })).toBe(false);
    expect(can(drafter, 'note.create', { type: 'note.create', kind: 'estimate', drafterId: 'dev-drafter' })).toBe(true);
    expect(can(drafter, 'note.create', { type: 'note.create', kind: 'estimate', drafterId: 'dev-drafter2' })).toBe(false);
    expect(can(viewer, 'note.create', { type: 'note.create', kind: 'estimate' })).toBe(false);
  });

  it('drafts: assigned drafter reads and writes; same-division drafter reads; end user sees nothing', () => {
    const n = note();
    expect(can(drafter, 'note.read', n)).toBe(true);
    expect(can(drafter, 'note.edit', n)).toBe(true);
    expect(can(drafter2, 'note.read', n)).toBe(true); // same division, configurable
    expect(can(drafter2, 'note.edit', n)).toBe(false);
    expect(can(drafter2, 'note.read', n, { divisionRead: false })).toBe(false);
    expect(can(otherDivDrafter, 'note.read', n)).toBe(false);
    expect(can(reviewer, 'note.read', n)).toBe(true);
    expect(can(reviewer, 'note.edit', n)).toBe(false);
    expect(can(reviewer, 'note.comment', n)).toBe(true);
    expect(can(viewer, 'note.read', n)).toBe(false);
    expect(can(viewer, 'note.export', n)).toBe(false);
  });

  it('note.edit follows the workflow state', () => {
    for (const state of ['todo', 'in_progress', 'changes_requested'] as const) {
      expect(can(drafter, 'note.edit', note({ state }))).toBe(true);
    }
    expect(can(drafter, 'note.edit', note({ state: 'review.pending' }))).toBe(false);
    expect(can(drafter, 'note.edit', note({ state: 'review.active', reviewerId: 'dev-reviewer' }))).toBe(false);
    expect(can(reviewer, 'note.edit', note({ state: 'review.active', reviewerId: 'dev-reviewer' }))).toBe(true);
    expect(can(reviewer, 'note.edit', note({ state: 'review.active', reviewerId: 'dev-reviewer' }), { reviewerEdit: false })).toBe(false);
    expect(can(reviewer2, 'note.edit', note({ state: 'review.active', reviewerId: 'dev-reviewer' }))).toBe(false);
    expect(can(drafter, 'note.edit', note({ state: 'approved' }))).toBe(false);
    const exec = note({ state: 'exec_review.active', execChain: [{ userId: 'dev-approver' }], execIndex: 0 });
    expect(can(approver, 'note.edit', exec)).toBe(true);
    expect(can(reviewer, 'note.edit', exec)).toBe(false);
  });

  it('submit for review is the assigned drafter in in_progress or changes_requested', () => {
    expect(can(drafter, 'note.submit_for_review', note({ state: 'in_progress' }))).toBe(true);
    expect(can(drafter, 'note.submit_for_review', note({ state: 'changes_requested' }))).toBe(true);
    expect(can(drafter, 'note.submit_for_review', note({ state: 'todo' }))).toBe(false);
    expect(can(drafter2, 'note.submit_for_review', note({ state: 'in_progress' }))).toBe(false);
    expect(can(reviewer, 'note.submit_for_review', note({ state: 'in_progress' }))).toBe(false);
  });

  it('note.review is the assigned reviewer for the current step', () => {
    const pending = note({ state: 'review.pending' });
    expect(can(reviewer, 'note.review', pending)).toBe(true); // unassigned: any reviewer may claim
    expect(can(drafter, 'note.review', pending)).toBe(false);
    const active = note({ state: 'review.active', reviewerId: 'dev-reviewer' });
    expect(can(reviewer, 'note.review', active)).toBe(true);
    expect(can(reviewer2, 'note.review', active)).toBe(false);
    const exec = note({ state: 'exec_review.pending', execChain: [{ userId: 'dev-approver' }, { userId: 'dev-exec-budget' }], execIndex: 1 });
    expect(can(approver, 'note.review', exec)).toBe(false);
    expect(can(execBudget, 'note.review', exec)).toBe(true);
    expect(can(reviewer, 'note.review', note({ state: 'in_progress' }))).toBe(false);
  });

  it('approved notes are readable and exportable by everyone, including end users', () => {
    const n = note({ state: 'approved', reviewerId: 'dev-reviewer' });
    for (const p of [drafter, drafter2, otherDivDrafter, reviewer, viewer, manager, admin]) {
      expect(can(p, 'note.read', n)).toBe(true);
      expect(can(p, 'note.export', n)).toBe(true);
    }
    expect(can(viewer, 'note.comment', n)).toBe(false);
  });

  it('confidential notes are visible only to assignees, assigned reviewers, managers and admins, even after approval', () => {
    const n = note({ state: 'approved', reviewerId: 'dev-reviewer', confidential: true });
    expect(can(drafter, 'note.read', n)).toBe(true);
    expect(can(reviewer, 'note.read', n)).toBe(true);
    expect(can(admin, 'note.read', n)).toBe(true);
    expect(can(manager, 'note.read', n)).toBe(true);
    expect(can(reviewer2, 'note.read', n)).toBe(false);
    expect(can(drafter2, 'note.read', n)).toBe(false);
    expect(can(viewer, 'note.read', n)).toBe(false);
    const inExec = note({ state: 'exec_review.pending', confidential: true, execChain: [{ userId: 'dev-exec-budget' }] });
    expect(can(execBudget, 'note.read', inExec)).toBe(true);
  });

  it('reopen after approval needs the approver role or admin', () => {
    const n = note({ state: 'approved', reviewerId: 'dev-reviewer' });
    expect(can(approver, 'note.reopen', n)).toBe(true);
    expect(can(admin, 'note.reopen', n)).toBe(true);
    expect(can(reviewer, 'note.reopen', n)).toBe(false);
    expect(can(approver, 'note.reopen', note({ state: 'in_progress' }))).toBe(false);
  });

  it('assign, cancel, duplicate: reviewer (assigner), manager, admin', () => {
    const n = note();
    for (const a of ['note.assign', 'note.cancel', 'note.duplicate'] as const) {
      expect(can(reviewer, a, n)).toBe(true);
      expect(can(manager, a, n)).toBe(true);
      expect(can(admin, a, n)).toBe(true);
      expect(can(drafter, a, n)).toBe(false);
      expect(can(viewer, a, n)).toBe(false);
    }
  });

  it('audit: participants see their own note history; reviewers see all in scope', () => {
    const n = note();
    expect(can(drafter, 'audit.read', n)).toBe(true);
    expect(can(drafter2, 'audit.read', n)).toBe(false);
    expect(can(reviewer, 'audit.read', n)).toBe(true);
    expect(can(reviewer, 'audit.read_all')).toBe(true);
    expect(can(drafter, 'audit.read_all')).toBe(false);
    expect(can(viewer, 'audit.read_all')).toBe(false);
    expect(can(reviewer, 'assignments.read_all')).toBe(true);
    expect(can(drafter, 'assignments.read_all')).toBe(false);
  });

  it('a user holding drafter and reviewer gets both sets of permissions', () => {
    const own = note({ drafterId: 'dev-both' });
    expect(can(both, 'note.edit', own)).toBe(true);
    expect(can(both, 'note.create', { type: 'note.create', kind: 'note' })).toBe(true);
    expect(can(both, 'note.review', note({ state: 'review.pending' }))).toBe(true);
    expect(toActor(both).roles).toEqual(expect.arrayContaining(['drafter', 'editor', 'manager']));
  });

  it('maps application roles to machine roles', () => {
    expect(toActor(drafter).roles).toEqual(['drafter']);
    expect(toActor(reviewer).roles).toEqual(expect.arrayContaining(['editor', 'manager']));
    expect(toActor(approver).roles).toEqual(expect.arrayContaining(['executive', 'editor']));
    expect(toActor(manager).roles).toEqual(['manager']);
    expect(toActor(viewer).roles).toEqual([]);
    expect(toActor({ userId: 'system', displayName: 'System', roles: ['admin'], divisions: [] }).roles).toContain('system');
  });
});
