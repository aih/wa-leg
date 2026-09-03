import { createActor, transition } from 'xstate';
import { fiscalNoteMachine, type Actor, type Ctx, type Ev, type EventType, type MachineInput } from './machine.js';
import { expandState, flattenState, isFinal, type WorkflowState } from './vocab.js';

/** Build the initial snapshot for a new instance. No actor is started. */
export function initialSnapshot(input: MachineInput) {
  const actor = createActor(fiscalNoteMachine, { input });
  const snap = actor.getSnapshot();
  return fiscalNoteMachine.resolveState({ value: snap.value, context: snap.context });
}

/** Plain JSON form for storage: `{ value, context }`. */
export function persist(snapshot: { value: unknown; context: Ctx }): { value: unknown; context: Ctx } {
  return JSON.parse(JSON.stringify({ value: snapshot.value, context: snapshot.context }));
}

/** Rehydrate a persisted snapshot. Accepts XState persisted form or a `{ state, context }` pair. */
export function resolve(persisted: unknown) {
  const p = persisted as { value?: unknown; state?: WorkflowState; context: Ctx };
  if (p.value !== undefined) return fiscalNoteMachine.resolveState(persisted as any);
  return fiscalNoteMachine.resolveState({ value: expandState(p.state as WorkflowState), context: p.context } as any);
}

/** Dummy event bodies used only for `can()` checks; the guard reads the actor and context. */
function probe(type: EventType, actor: Actor): Ev {
  switch (type) {
    case 'ASSIGN_DRAFTER':
      return { type, actor, userId: actor.userId };
    case 'REQUEST_CHANGES':
    case 'EXEC_RETURN':
    case 'CANCEL':
      return { type, actor, comment: '' };
    case 'SET_EXEC_CHAIN':
      return { type, actor, chain: [] };
    case 'REASSIGN':
      return { type, actor, role: 'drafter', userId: actor.userId };
    case 'SUPERSEDE':
      return { type, actor, newBillVersionId: '' };
    default:
      return { type, actor } as Ev;
  }
}

/** True when `actor` may send `type` to the instance described by `persisted`. Pure; safe on the client. */
export function can(persisted: unknown, type: EventType, actor: Actor): boolean {
  const snap = resolve(persisted);
  if (isFinal(flattenState(snap.value))) return false;
  return snap.can(probe(type, actor));
}

export function availableEvents(persisted: unknown, actor: Actor, candidates: readonly EventType[]): EventType[] {
  const snap = resolve(persisted);
  if (isFinal(flattenState(snap.value))) return [];
  return candidates.filter((t) => snap.can(probe(t, actor)));
}

export interface StepResult {
  snapshot: ReturnType<typeof resolve>;
  state: WorkflowState;
  context: Ctx;
  actions: { type: string; params?: unknown }[];
}

/** Pure transition. Throws `NotAllowedError` when the guard fails or the event is not handled in this state. */
export function step(persisted: unknown, event: Ev): StepResult {
  const snap = resolve(persisted);
  const from = flattenState(snap.value);
  if (isFinal(from) || !snap.can(event)) {
    throw new NotAllowedError(from, event.type);
  }
  const [next, actions] = transition(fiscalNoteMachine, snap, event);
  return {
    snapshot: next,
    state: flattenState(next.value),
    context: next.context,
    actions: actions.map((a) => ({ type: a.type, params: (a as { params?: unknown }).params })),
  };
}

export class NotAllowedError extends Error {
  constructor(
    public readonly state: WorkflowState,
    public readonly event: string,
  ) {
    super(`Event ${event} is not allowed in state ${state}`);
    this.name = 'NotAllowedError';
  }
}

export function stateOf(persisted: unknown): WorkflowState {
  return flattenState(resolve(persisted).value);
}
