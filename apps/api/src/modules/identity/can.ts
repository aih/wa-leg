// Authorization: `can(principal, action, resource)` from the matrix in docs/SIMPLIFY-0.2.md section 2.
// A note's state, drafter and reviewer come from the workflow instance.
import { isEditable, type WorkflowState } from '@wa-leg/workflow-machine';
import { hasRole, type Principal } from './principal.js';

export type Action =
  | 'bill.read'
  | 'template.read'
  | 'note.create'
  | 'note.read'
  | 'note.edit'
  | 'note.comment'
  | 'note.submit'
  | 'note.review'
  | 'note.publish'
  | 'note.export'
  | 'audit.read'
  | 'audit.read_all'
  | 'template.edit'
  | 'ingest.run'
  | 'search.reindex';

export interface NoteResource {
  type: 'note';
  state: WorkflowState;
  drafterId: string | null;
  reviewerId: string | null;
  /** Extra user ids who may read (comment authors, the creator). */
  participantIds?: string[];
}

export interface CreateNoteResource {
  type: 'note.create';
  /** Drafter the caller wants assigned; a drafter may only create for themselves. */
  drafterId?: string | null;
}

export type Resource = NoteResource | CreateNoteResource | { type: 'none' };

function isParticipant(p: Principal, n: NoteResource): boolean {
  if (n.drafterId === p.userId || n.reviewerId === p.userId) return true;
  return n.participantIds?.includes(p.userId) ?? false;
}

function canReadNote(p: Principal, n: NoteResource): boolean {
  if (hasRole(p, 'admin', 'reviewer')) return true;
  if (n.state === 'published') return true;
  if (hasRole(p, 'drafter')) return isParticipant(p, n);
  return false;
}

export function can(p: Principal, action: Action, resource: Resource = { type: 'none' }): boolean {
  const admin = hasRole(p, 'admin');
  switch (action) {
    case 'bill.read':
    case 'template.read':
      return true;
    case 'audit.read_all':
    case 'template.edit':
    case 'ingest.run':
    case 'search.reindex':
      return admin;
    case 'note.create': {
      if (admin || hasRole(p, 'reviewer')) return true;
      if (!hasRole(p, 'drafter')) return false;
      const drafterId = resource.type === 'note.create' ? resource.drafterId : null;
      return !drafterId || drafterId === p.userId;
    }
    default:
      break;
  }
  if (resource.type !== 'note') return admin;
  const n = resource;
  switch (action) {
    case 'note.read':
    case 'note.export':
      return canReadNote(p, n);
    case 'note.edit':
      return isEditable(n.state) && n.drafterId === p.userId;
    case 'note.submit':
      return isEditable(n.state) && n.drafterId === p.userId;
    case 'note.comment':
      return canReadNote(p, n) && hasRole(p, 'drafter', 'reviewer', 'admin');
    case 'note.review':
      return n.state === 'in_review' && hasRole(p, 'reviewer') && n.drafterId !== p.userId;
    case 'note.publish':
      return n.state === 'approved' && hasRole(p, 'reviewer') && n.drafterId !== p.userId;
    case 'audit.read':
      return admin || hasRole(p, 'reviewer') || isParticipant(p, n);
    default:
      return false;
  }
}
