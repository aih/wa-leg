import { describe, expect, it } from 'vitest';
import { can, type NoteResource } from '../src/modules/identity/index.js';
import { users } from './helpers.js';

const note = (over: Partial<NoteResource> = {}): NoteResource => ({
  type: 'note',
  state: 'draft',
  drafterId: 'dev-drafter',
  reviewerId: null,
  ...over,
});

const { drafter, reviewer, viewer, both, admin } = users;
const everyone = [drafter, reviewer, viewer, both, admin];

describe('can(): permission matrix', () => {
  it('bills and templates are readable by everyone', () => {
    for (const p of everyone) {
      expect(can(p, 'bill.read')).toBe(true);
      expect(can(p, 'template.read')).toBe(true);
    }
  });

  it('template editing, ingest, reindex and the audit query are admin only', () => {
    for (const a of ['template.edit', 'ingest.run', 'search.reindex', 'audit.read_all'] as const) {
      expect(can(admin, a)).toBe(true);
      for (const p of [drafter, reviewer, viewer, both]) expect(can(p, a)).toBe(false);
    }
  });

  it('note.create: reviewers name a drafter; drafters create for themselves; viewers cannot', () => {
    expect(can(reviewer, 'note.create', { type: 'note.create', drafterId: 'dev-drafter' })).toBe(true);
    expect(can(reviewer, 'note.create', { type: 'note.create' })).toBe(true);
    expect(can(admin, 'note.create', { type: 'note.create', drafterId: 'dev-drafter' })).toBe(true);
    expect(can(drafter, 'note.create', { type: 'note.create' })).toBe(true);
    expect(can(drafter, 'note.create', { type: 'note.create', drafterId: 'dev-drafter' })).toBe(true);
    expect(can(drafter, 'note.create', { type: 'note.create', drafterId: 'dev-both' })).toBe(false);
    expect(can(both, 'note.create', { type: 'note.create', drafterId: 'dev-drafter' })).toBe(true);
    expect(can(viewer, 'note.create', { type: 'note.create' })).toBe(false);
    expect(can(viewer, 'note.create', { type: 'note.create', drafterId: 'dev-committee' })).toBe(false);
  });

  it('drafts: the drafter reads, edits and comments; reviewers read and comment; viewers see nothing', () => {
    const n = note();
    expect(can(drafter, 'note.read', n)).toBe(true);
    expect(can(drafter, 'note.edit', n)).toBe(true);
    expect(can(drafter, 'note.comment', n)).toBe(true);
    expect(can(reviewer, 'note.read', n)).toBe(true);
    expect(can(reviewer, 'note.edit', n)).toBe(false);
    expect(can(reviewer, 'note.comment', n)).toBe(true);
    expect(can(both, 'note.read', n)).toBe(true);
    expect(can(both, 'note.edit', n)).toBe(false);
    expect(can(viewer, 'note.read', n)).toBe(false);
    expect(can(viewer, 'note.export', n)).toBe(false);
    expect(can(viewer, 'note.comment', n)).toBe(false);
    expect(can(admin, 'note.read', n)).toBe(true);
    expect(can(admin, 'note.edit', n)).toBe(false);
  });

  it('another drafter reads only as a participant', () => {
    const n = note({ drafterId: 'dev-both' });
    expect(can(drafter, 'note.read', n)).toBe(false);
    expect(can(drafter, 'note.read', note({ drafterId: 'dev-both', participantIds: ['dev-drafter'] }))).toBe(true);
    expect(can(drafter, 'note.edit', note({ drafterId: 'dev-both', participantIds: ['dev-drafter'] }))).toBe(false);
  });

  it('note.edit and note.submit follow the state', () => {
    for (const state of ['draft', 'changes_requested'] as const) {
      expect(can(drafter, 'note.edit', note({ state }))).toBe(true);
      expect(can(drafter, 'note.submit', note({ state }))).toBe(true);
    }
    for (const state of ['in_review', 'approved', 'published'] as const) {
      expect(can(drafter, 'note.edit', note({ state, reviewerId: 'dev-reviewer' }))).toBe(false);
      expect(can(drafter, 'note.submit', note({ state, reviewerId: 'dev-reviewer' }))).toBe(false);
      expect(can(reviewer, 'note.edit', note({ state, reviewerId: 'dev-reviewer' }))).toBe(false);
    }
    expect(can(both, 'note.submit', note({ state: 'draft' }))).toBe(false);
    expect(can(both, 'note.submit', note({ state: 'draft', drafterId: 'dev-both' }))).toBe(true);
  });

  it('note.review is a reviewer other than the drafter while in review', () => {
    const n = note({ state: 'in_review' });
    expect(can(reviewer, 'note.review', n)).toBe(true);
    expect(can(both, 'note.review', n)).toBe(true);
    expect(can(both, 'note.review', note({ state: 'in_review', drafterId: 'dev-both' }))).toBe(false);
    expect(can(drafter, 'note.review', n)).toBe(false);
    expect(can(viewer, 'note.review', n)).toBe(false);
    expect(can(admin, 'note.review', n)).toBe(false);
    for (const state of ['draft', 'changes_requested', 'approved', 'published'] as const) expect(can(reviewer, 'note.review', note({ state }))).toBe(false);
  });

  it('note.publish is a reviewer other than the drafter while approved', () => {
    const n = note({ state: 'approved', reviewerId: 'dev-reviewer' });
    expect(can(reviewer, 'note.publish', n)).toBe(true);
    expect(can(both, 'note.publish', n)).toBe(true);
    expect(can(both, 'note.publish', note({ state: 'approved', drafterId: 'dev-both' }))).toBe(false);
    expect(can(drafter, 'note.publish', n)).toBe(false);
    expect(can(viewer, 'note.publish', n)).toBe(false);
    for (const state of ['draft', 'in_review', 'changes_requested', 'published'] as const) expect(can(reviewer, 'note.publish', note({ state }))).toBe(false);
  });

  it('approved notes stay with the participants and reviewers; published notes are readable and exportable by everyone', () => {
    const approved = note({ state: 'approved', reviewerId: 'dev-reviewer' });
    expect(can(viewer, 'note.read', approved)).toBe(false);
    expect(can(drafter, 'note.read', approved)).toBe(true);
    const published = note({ state: 'published', reviewerId: 'dev-reviewer' });
    for (const p of everyone) {
      expect(can(p, 'note.read', published)).toBe(true);
      expect(can(p, 'note.export', published)).toBe(true);
      expect(can(p, 'note.edit', published)).toBe(false);
    }
    expect(can(viewer, 'note.comment', published)).toBe(false);
  });

  it('audit: participants and reviewers see a note history; the audit query is admin only', () => {
    const n = note();
    expect(can(drafter, 'audit.read', n)).toBe(true);
    expect(can(reviewer, 'audit.read', n)).toBe(true);
    expect(can(both, 'audit.read', n)).toBe(true);
    expect(can(viewer, 'audit.read', n)).toBe(false);
    expect(can(drafter, 'audit.read', note({ drafterId: 'dev-both' }))).toBe(false);
    expect(can(admin, 'audit.read_all')).toBe(true);
    expect(can(reviewer, 'audit.read_all')).toBe(false);
  });

  it('a user holding drafter and reviewer gets both sets of permissions', () => {
    expect(can(both, 'note.edit', note({ drafterId: 'dev-both' }))).toBe(true);
    expect(can(both, 'note.create', { type: 'note.create', drafterId: 'dev-drafter' })).toBe(true);
    expect(can(both, 'note.review', note({ state: 'in_review' }))).toBe(true);
  });

  it('actions on a non-note resource fall back to admin', () => {
    expect(can(admin, 'note.read')).toBe(true);
    expect(can(reviewer, 'note.read')).toBe(false);
  });
});
