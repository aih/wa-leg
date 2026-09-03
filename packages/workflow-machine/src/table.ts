// Fiscal note workflow: a transition table over five states and four events (docs/SIMPLIFY-0.2.md section 2).
// Evaluated on the server by the workflow service; pure, so the client can call it too.

export type WorkflowState = 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'published';
export const WORKFLOW_STATES: readonly WorkflowState[] = ['draft', 'in_review', 'changes_requested', 'approved', 'published'];

export type EventType = 'SUBMIT' | 'REQUEST_CHANGES' | 'APPROVE' | 'PUBLISH';
export const EVENT_TYPES: readonly EventType[] = ['SUBMIT', 'REQUEST_CHANGES', 'APPROVE', 'PUBLISH'];

export type ActorRole = 'drafter' | 'reviewer' | 'viewer' | 'admin';
export interface Actor {
  userId: string;
  roles: readonly ActorRole[];
}

export interface Ctx {
  drafterId: string | null;
  reviewerId: string | null;
}

/** Who may send an event: the note's drafter, or any user with the reviewer role who is not the drafter. */
export type Who = 'drafter' | 'reviewer';

export interface Rule {
  from: WorkflowState;
  event: EventType;
  who: Who;
  to: WorkflowState;
  /** The event needs a non-empty message. */
  requiresMessage: boolean;
}

export const TRANSITIONS: readonly Rule[] = [
  { from: 'draft', event: 'SUBMIT', who: 'drafter', to: 'in_review', requiresMessage: false },
  { from: 'changes_requested', event: 'SUBMIT', who: 'drafter', to: 'in_review', requiresMessage: false },
  { from: 'in_review', event: 'REQUEST_CHANGES', who: 'reviewer', to: 'changes_requested', requiresMessage: true },
  { from: 'in_review', event: 'APPROVE', who: 'reviewer', to: 'approved', requiresMessage: false },
  { from: 'approved', event: 'PUBLISH', who: 'reviewer', to: 'published', requiresMessage: false },
];

export const FINAL_STATES: readonly WorkflowState[] = ['published'];
/** States in which the drafter may edit the document. */
export const EDITABLE_STATES: readonly WorkflowState[] = ['draft', 'changes_requested'];

export function isFinal(state: WorkflowState): boolean {
  return FINAL_STATES.includes(state);
}

export function isEditable(state: WorkflowState): boolean {
  return EDITABLE_STATES.includes(state);
}

/** True when `actor` is the note's drafter. */
export function isDrafter(actor: Actor, ctx: Ctx): boolean {
  return ctx.drafterId !== null && actor.userId === ctx.drafterId;
}

/** True when `actor` holds the reviewer role and is not the note's drafter. */
export function isReviewer(actor: Actor, ctx: Ctx): boolean {
  return actor.roles.includes('reviewer') && actor.userId !== ctx.drafterId;
}

function actsAs(who: Who, actor: Actor, ctx: Ctx): boolean {
  return who === 'drafter' ? isDrafter(actor, ctx) : isReviewer(actor, ctx);
}

export type RefusalReason = 'unknown_event' | 'not_in_state' | 'not_allowed' | 'message_required';

export interface Refusal {
  ok: false;
  reason: RefusalReason;
  state: WorkflowState;
  event: string;
  message: string;
}

export interface Accepted {
  ok: true;
  state: WorkflowState;
  /** Context after the event; the first review action sets `reviewerId`. */
  ctx: Ctx;
  rule: Rule;
}

export type TransitionResult = Accepted | Refusal;

export interface TransitionInput {
  message?: string | null;
}

function refuse(reason: RefusalReason, state: WorkflowState, event: string, message: string): Refusal {
  return { ok: false, reason, state, event, message };
}

/**
 * Apply `event` to `state` for `actor`. Returns the next state and context, or a refusal saying why not.
 * The context is never mutated.
 */
export function transition(state: WorkflowState, event: EventType, actor: Actor, ctx: Ctx, input: TransitionInput = {}): TransitionResult {
  if (!EVENT_TYPES.includes(event)) return refuse('unknown_event', state, event, `Unknown event ${event}`);
  const rule = TRANSITIONS.find((r) => r.from === state && r.event === event);
  if (!rule) return refuse('not_in_state', state, event, `${EVENT_LABELS[event]} is not available while the note is ${STATE_LABELS[state].toLowerCase()}`);
  if (!actsAs(rule.who, actor, ctx)) return refuse('not_allowed', state, event, rule.who === 'drafter' ? `Only the drafter may ${EVENT_LABELS[event].toLowerCase()}` : `Only a reviewer other than the drafter may ${EVENT_LABELS[event].toLowerCase()}`);
  if (rule.requiresMessage && !input.message?.trim()) return refuse('message_required', state, event, `${EVENT_LABELS[event]} needs a message`);
  const next: Ctx = rule.who === 'reviewer' && ctx.reviewerId === null ? { ...ctx, reviewerId: actor.userId } : { ...ctx };
  return { ok: true, state: rule.to, ctx: next, rule };
}

/** Events `actor` may send from `state`, in table order. The message requirement is not checked here. */
export function availableEvents(state: WorkflowState, actor: Actor, ctx: Ctx): EventType[] {
  return TRANSITIONS.filter((r) => r.from === state && actsAs(r.who, actor, ctx)).map((r) => r.event);
}

export const STATE_LABELS: Record<WorkflowState, string> = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  published: 'Published',
};

export const STATE_HINTS: Record<WorkflowState, string> = {
  draft: 'The drafter is writing',
  in_review: 'A reviewer is reading it',
  changes_requested: 'Back with the drafter, with the reviewer’s message and the open comment threads',
  approved: 'Frozen at the approved version',
  published: 'Available to the Committee beside the bill and on the Published page',
};

export const EVENT_LABELS: Record<EventType, string> = {
  SUBMIT: 'Submit for review',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
  PUBLISH: 'Publish',
};
