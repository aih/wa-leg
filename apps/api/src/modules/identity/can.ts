// Authorization: `can(principal, action, resource)` from the matrix in design/research/personas-dashboards.md.
// Resource state for notes comes from the workflow snapshot; confidentiality from the note's flag.
import type { WorkflowState } from '@wa-leg/workflow-machine';
import { hasRole, type Principal } from './principal.js';

export type Action =
  | 'bill.read'
  | 'note.create'
  | 'note.read'
  | 'note.edit'
  | 'note.submit_for_review'
  | 'note.review'
  | 'note.reopen'
  | 'note.assign'
  | 'note.cancel'
  | 'note.duplicate'
  | 'note.export'
  | 'note.comment'
  | 'note.comment_reply'
  | 'note.patch'
  | 'audit.read'
  | 'audit.read_all'
  | 'assignments.read_all'
  | 'template.read'
  | 'template.edit'
  | 'ingest.run'
  | 'search.reindex';

export interface NoteResource {
  type: 'note';
  state: WorkflowState;
  drafterId: string | null;
  reviewerId: string | null;
  execChain?: { userId: string }[];
  execIndex?: number;
  confidential: boolean;
  /** Division of the assigned drafter, for the same-division read rule. */
  division?: string | null;
  kind?: 'note' | 'estimate';
  /** Extra user ids who may read (comment authors, previous assignees). */
  participantIds?: string[];
}

export interface CreateNoteResource {
  type: 'note.create';
  kind: 'note' | 'estimate';
  /** Drafter the caller wants assigned; drafters may only create estimates for themselves. */
  drafterId?: string | null;
}

export type Resource = NoteResource | CreateNoteResource | { type: 'none' };

export interface CanOptions {
  divisionRead: boolean;
  reviewerEdit: boolean;
}

const DEFAULTS: CanOptions = { divisionRead: true, reviewerEdit: true };

const DRAFT_STATES: WorkflowState[] = ['todo', 'in_progress', 'changes_requested'];
const REVIEW_STATES: WorkflowState[] = ['review.pending', 'review.active'];
const EXEC_STATES: WorkflowState[] = ['exec_review.pending', 'exec_review.active'];

function isParticipant(p: Principal, n: NoteResource): boolean {
  if (n.drafterId === p.userId || n.reviewerId === p.userId) return true;
  if (n.execChain?.some((s) => s.userId === p.userId)) return true;
  return n.participantIds?.includes(p.userId) ?? false;
}

function isReviewerRole(p: Principal): boolean {
  return hasRole(p, 'reviewer', 'approver', 'manager');
}

function currentExec(n: NoteResource): string | null {
  return n.execChain?.[n.execIndex ?? 0]?.userId ?? null;
}

function canReadNote(p: Principal, n: NoteResource, o: CanOptions): boolean {
  if (hasRole(p, 'admin')) return true;
  if (n.confidential) {
    // Confidential notes: assignees, assigned reviewers, admins (and managers, who assign them).
    return isParticipant(p, n) || hasRole(p, 'manager');
  }
  if (n.state === 'approved') return true;
  if (isParticipant(p, n)) return true;
  if (isReviewerRole(p)) return true;
  if (hasRole(p, 'drafter') && o.divisionRead && n.division && p.divisions.includes(n.division)) return true;
  return false;
}

function canEditNote(p: Principal, n: NoteResource, o: CanOptions): boolean {
  if (DRAFT_STATES.includes(n.state)) return n.drafterId === p.userId;
  if (n.state === 'review.active') return o.reviewerEdit && n.reviewerId === p.userId;
  if (n.state === 'exec_review.active') return currentExec(n) === p.userId;
  return false;
}

export function can(p: Principal, action: Action, resource: Resource = { type: 'none' }, opts: Partial<CanOptions> = {}): boolean {
  const o = { ...DEFAULTS, ...opts };
  const admin = hasRole(p, 'admin');
  switch (action) {
    case 'bill.read':
    case 'template.read':
      return true;
    case 'template.edit':
      return admin || hasRole(p, 'template_editor');
    case 'ingest.run':
    case 'search.reindex':
      return admin;
    case 'audit.read_all':
    case 'assignments.read_all':
    case 'note.assign':
    case 'note.cancel':
    case 'note.duplicate':
    case 'note.patch':
      return admin || isReviewerRole(p);
    case 'note.create': {
      if (admin || isReviewerRole(p)) return true;
      if (resource.type === 'note.create' && resource.kind === 'estimate' && hasRole(p, 'drafter')) {
        return !resource.drafterId || resource.drafterId === p.userId;
      }
      return false;
    }
    default:
      break;
  }
  if (resource.type !== 'note') return admin;
  const n = resource;
  switch (action) {
    case 'note.read':
      return canReadNote(p, n, o);
    case 'note.export':
      return canReadNote(p, n, o);
    case 'audit.read':
      return admin || isReviewerRole(p) || isParticipant(p, n);
    case 'note.edit':
      return canReadNote(p, n, o) && canEditNote(p, n, o);
    case 'note.submit_for_review':
      return n.drafterId === p.userId && (n.state === 'in_progress' || n.state === 'changes_requested');
    case 'note.review': {
      if (!canReadNote(p, n, o)) return false;
      if (REVIEW_STATES.includes(n.state)) return isReviewerRole(p) && (n.reviewerId === null || n.reviewerId === p.userId);
      if (EXEC_STATES.includes(n.state)) return currentExec(n) === p.userId;
      return false;
    }
    case 'note.comment':
      return canReadNote(p, n, o) && !hasRole(p, 'viewer') && (hasRole(p, 'drafter') || isReviewerRole(p) || admin);
    case 'note.comment_reply':
      return canReadNote(p, n, o) && (hasRole(p, 'drafter') || isReviewerRole(p) || admin);
    case 'note.reopen':
      return n.state === 'approved' && (admin || hasRole(p, 'approver'));
    default:
      return false;
  }
}
