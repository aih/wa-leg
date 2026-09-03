// Flattened workflow states and the role-facing vocabularies (design/research/personas-dashboards.md,
// design/research/workflow-engine.md section 3).

export type WorkflowState =
  | 'todo'
  | 'in_progress'
  | 'review.pending'
  | 'review.active'
  | 'changes_requested'
  | 'exec_review.pending'
  | 'exec_review.active'
  | 'approved'
  | 'cancelled'
  | 'superseded';

export const WORKFLOW_STATES: WorkflowState[] = [
  'todo',
  'in_progress',
  'review.pending',
  'review.active',
  'changes_requested',
  'exec_review.pending',
  'exec_review.active',
  'approved',
  'cancelled',
  'superseded',
];

export const FINAL_STATES: WorkflowState[] = ['approved', 'cancelled', 'superseded'];
export const EDITABLE_BY_DRAFTER: WorkflowState[] = ['todo', 'in_progress', 'changes_requested'];
export const EDITABLE_BY_REVIEWER: WorkflowState[] = ['review.active'];
export const EDITABLE_BY_EXEC: WorkflowState[] = ['exec_review.active'];

export function isFinal(state: WorkflowState): boolean {
  return FINAL_STATES.includes(state);
}

/** Flatten an XState state value such as `{ review: 'pending' }` to `review.pending`. */
export function flattenState(value: unknown): WorkflowState {
  if (typeof value === 'string') return value as WorkflowState;
  if (value && typeof value === 'object') {
    const [k, v] = Object.entries(value as Record<string, unknown>)[0] ?? [];
    if (k) return `${k}.${flattenState(v)}` as WorkflowState;
  }
  throw new Error(`Unrecognised state value ${JSON.stringify(value)}`);
}

/** Expand `review.pending` back into the XState state value form. */
export function expandState(state: WorkflowState): string | Record<string, string> {
  const [a, b] = state.split('.');
  return b ? { [a as string]: b } : (a as string);
}

export type DrafterStatus = 'to-do' | 'in-progress' | 'ready-for-review' | 'address-review' | 'approved' | 'cancelled' | 'superseded';
export type ReviewerStatus = 'unstarted' | 'drafting' | 'pending' | 'in-review' | 'changes-requested' | 'approved' | 'cancelled' | 'superseded';

export function drafterStatus(state: WorkflowState): DrafterStatus {
  switch (state) {
    case 'todo':
      return 'to-do';
    case 'in_progress':
      return 'in-progress';
    case 'review.pending':
    case 'review.active':
    case 'exec_review.pending':
    case 'exec_review.active':
      return 'ready-for-review';
    case 'changes_requested':
      return 'address-review';
    case 'approved':
      return 'approved';
    case 'cancelled':
      return 'cancelled';
    case 'superseded':
      return 'superseded';
  }
}

export function reviewerStatus(state: WorkflowState): ReviewerStatus {
  switch (state) {
    case 'todo':
      return 'unstarted';
    case 'in_progress':
      return 'drafting';
    case 'review.pending':
    case 'exec_review.pending':
      return 'pending';
    case 'review.active':
    case 'exec_review.active':
      return 'in-review';
    case 'changes_requested':
      return 'changes-requested';
    case 'approved':
      return 'approved';
    case 'cancelled':
      return 'cancelled';
    case 'superseded':
      return 'superseded';
  }
}

export const DRAFTER_LABELS: Record<DrafterStatus, string> = {
  'to-do': 'To do',
  'in-progress': 'In progress',
  'ready-for-review': 'Ready for review',
  'address-review': 'Address review',
  approved: 'Approved',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};

export const REVIEWER_LABELS: Record<ReviewerStatus, string> = {
  unstarted: 'Unstarted',
  drafting: 'Drafting',
  pending: 'Pending my review',
  'in-review': 'In review',
  'changes-requested': 'Changes requested',
  approved: 'Approved',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};

export const EVENT_LABELS: Record<string, string> = {
  ASSIGN_DRAFTER: 'Assign drafter',
  START: 'Start drafting',
  SUBMIT_FOR_REVIEW: 'Submit for review',
  CLAIM_REVIEW: 'Claim review',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
  SET_EXEC_CHAIN: 'Set executive review chain',
  EXEC_CLAIM: 'Start executive review',
  EXEC_DONE: 'Executive review done',
  EXEC_RETURN: 'Return to drafter',
  REASSIGN: 'Reassign',
  CANCEL: 'Cancel',
  SUPERSEDE: 'Supersede',
};

/** Events a user can trigger from a button, in display order. Administrative events are excluded. */
export const BUTTON_EVENTS = [
  'START',
  'SUBMIT_FOR_REVIEW',
  'CLAIM_REVIEW',
  'REQUEST_CHANGES',
  'APPROVE',
  'EXEC_CLAIM',
  'EXEC_DONE',
  'EXEC_RETURN',
  'CANCEL',
] as const;
