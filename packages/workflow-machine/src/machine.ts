// Fiscal note review workflow. One machine instance per note revision.
// Evaluated on the server with the pure `transition()` function and on the client with `can()`.
// Source: design/research/workflow-engine.md section 3.
import { setup, assign, and } from 'xstate';

export type MachineRole = 'drafter' | 'editor' | 'executive' | 'manager' | 'system';
export interface Actor {
  userId: string;
  roles: MachineRole[];
}
export interface ExecStep {
  userId: string;
  division: string;
  dueAt: string | null;
  doneAt: string | null;
}

export interface Ctx {
  noteRevisionId: string;
  billVersionId: string;
  drafterId: string | null;
  reviewerId: string | null;
  execChain: ExecStep[];
  execIndex: number;
}

type WithActor<T> = T & { actor: Actor };
export type Ev =
  | WithActor<{ type: 'ASSIGN_DRAFTER'; userId: string; dueAt?: string }>
  | WithActor<{ type: 'START' }>
  | WithActor<{ type: 'SUBMIT_FOR_REVIEW'; comment?: string }>
  | WithActor<{ type: 'CLAIM_REVIEW' }>
  | WithActor<{ type: 'REQUEST_CHANGES'; comment: string }>
  | WithActor<{ type: 'APPROVE'; comment?: string }>
  | WithActor<{ type: 'SET_EXEC_CHAIN'; chain: ExecStep[] }>
  | WithActor<{ type: 'EXEC_CLAIM' }>
  | WithActor<{ type: 'EXEC_DONE'; comment?: string }>
  | WithActor<{ type: 'EXEC_RETURN'; comment: string }>
  | WithActor<{ type: 'REASSIGN'; role: 'drafter' | 'reviewer' | 'exec'; userId: string; position?: number }>
  | WithActor<{ type: 'CANCEL'; comment: string }>
  | WithActor<{ type: 'SUPERSEDE'; newBillVersionId: string }>;

export type EventType = Ev['type'];
export const EVENT_TYPES: EventType[] = [
  'ASSIGN_DRAFTER',
  'START',
  'SUBMIT_FOR_REVIEW',
  'CLAIM_REVIEW',
  'REQUEST_CHANGES',
  'APPROVE',
  'SET_EXEC_CHAIN',
  'EXEC_CLAIM',
  'EXEC_DONE',
  'EXEC_RETURN',
  'REASSIGN',
  'CANCEL',
  'SUPERSEDE',
];

export type MachineInput = Pick<Ctx, 'noteRevisionId' | 'billVersionId'> & Partial<Ctx>;

const has = (e: { actor: Actor }, r: MachineRole) => e.actor.roles.includes(r);

export const fiscalNoteMachine = setup({
  types: {
    context: {} as Ctx,
    events: {} as Ev,
    input: {} as MachineInput,
  },
  guards: {
    isDrafter: ({ context, event }) => context.drafterId !== null && event.actor.userId === context.drafterId,
    isEditor: ({ event }) => has(event, 'editor'),
    isManager: ({ event }) => has(event, 'manager'),
    isManagerOrEditor: ({ event }) => has(event, 'manager') || has(event, 'editor'),
    isSystem: ({ event }) => has(event, 'system'),
    isAssignedReviewer: ({ context, event }) =>
      context.reviewerId !== null && event.actor.userId === context.reviewerId,
    canClaimReview: ({ context, event }) =>
      (context.reviewerId !== null && event.actor.userId === context.reviewerId) ||
      (context.reviewerId === null && has(event, 'editor')),
    isCurrentExec: ({ context, event }) => context.execChain[context.execIndex]?.userId === event.actor.userId,
    hasExecChain: ({ context }) => context.execChain.length > 0,
    execChainComplete: ({ context }) => context.execIndex + 1 >= context.execChain.length,
  },
  actions: {
    setDrafter: assign({
      drafterId: ({ event, context }) => (event.type === 'ASSIGN_DRAFTER' ? event.userId : context.drafterId),
    }),
    setReviewer: assign({
      reviewerId: ({ context, event }) => context.reviewerId ?? event.actor.userId,
    }),
    setExecChain: assign({
      execChain: ({ event, context }) => (event.type === 'SET_EXEC_CHAIN' ? event.chain : context.execChain),
      execIndex: 0,
    }),
    markExecStepDone: assign({
      execChain: ({ context }) =>
        context.execChain.map((s, i) => (i === context.execIndex ? { ...s, doneAt: new Date().toISOString() } : s)),
    }),
    advanceExec: assign({ execIndex: ({ context }) => context.execIndex + 1 }),
    resetExec: assign({
      execIndex: 0,
      execChain: ({ context }) => context.execChain.map((s) => ({ ...s, doneAt: null })),
    }),
    reassign: assign(({ context, event }) => {
      if (event.type !== 'REASSIGN') return {};
      if (event.role === 'drafter') return { drafterId: event.userId };
      if (event.role === 'reviewer') return { reviewerId: event.userId };
      const chain = context.execChain.map((s, i) => (i === (event.position ?? 0) ? { ...s, userId: event.userId } : s));
      return { execChain: chain };
    }),
    // Side effects are returned to the caller of transition() and executed by the workflow service.
    notify: (_, _params: { to: 'drafter' | 'reviewer' | 'editors' | 'currentExec' | 'manager' }) => {},
    emit: (_, _params: { type: 'note.assigned' | 'note.approved' | 'note.superseded' }) => {},
  },
}).createMachine({
  id: 'fiscalNote',
  context: ({ input }) => ({
    noteRevisionId: input.noteRevisionId,
    billVersionId: input.billVersionId,
    drafterId: input.drafterId ?? null,
    reviewerId: input.reviewerId ?? null,
    execChain: input.execChain ?? [],
    execIndex: input.execIndex ?? 0,
  }),
  initial: 'todo',
  on: {
    REASSIGN: {
      guard: 'isManager',
      actions: ['reassign', { type: 'emit', params: { type: 'note.assigned' } }],
    },
    CANCEL: { guard: 'isManager', target: '.cancelled' },
    SUPERSEDE: {
      guard: 'isSystem',
      target: '.superseded',
      actions: [{ type: 'emit', params: { type: 'note.superseded' } }],
    },
    SET_EXEC_CHAIN: { guard: 'isManager', actions: 'setExecChain' },
  },
  states: {
    todo: {
      on: {
        ASSIGN_DRAFTER: {
          guard: 'isManagerOrEditor',
          actions: [
            'setDrafter',
            { type: 'notify', params: { to: 'drafter' } },
            { type: 'emit', params: { type: 'note.assigned' } },
          ],
        },
        START: { guard: 'isDrafter', target: 'in_progress' },
      },
    },
    in_progress: {
      on: {
        ASSIGN_DRAFTER: {
          guard: 'isManagerOrEditor',
          actions: [
            'setDrafter',
            { type: 'notify', params: { to: 'drafter' } },
            { type: 'emit', params: { type: 'note.assigned' } },
          ],
        },
        SUBMIT_FOR_REVIEW: { guard: 'isDrafter', target: 'review' },
      },
    },
    review: {
      initial: 'pending',
      entry: { type: 'notify', params: { to: 'editors' } },
      states: {
        pending: {
          on: { CLAIM_REVIEW: { guard: 'canClaimReview', target: 'active', actions: 'setReviewer' } },
        },
        active: {
          on: {
            REQUEST_CHANGES: { guard: 'isAssignedReviewer', target: '#fiscalNote.changes_requested' },
            APPROVE: [
              { guard: and(['isAssignedReviewer', 'hasExecChain']), target: '#fiscalNote.exec_review' },
              { guard: 'isAssignedReviewer', target: '#fiscalNote.approved' },
            ],
          },
        },
      },
    },
    changes_requested: {
      entry: { type: 'notify', params: { to: 'drafter' } },
      on: {
        ASSIGN_DRAFTER: {
          guard: 'isManagerOrEditor',
          actions: [
            'setDrafter',
            { type: 'notify', params: { to: 'drafter' } },
            { type: 'emit', params: { type: 'note.assigned' } },
          ],
        },
        SUBMIT_FOR_REVIEW: { guard: 'isDrafter', target: 'review' },
      },
    },
    exec_review: {
      initial: 'pending',
      states: {
        pending: {
          entry: { type: 'notify', params: { to: 'currentExec' } },
          on: { EXEC_CLAIM: { guard: 'isCurrentExec', target: 'active' } },
        },
        active: {
          on: {
            EXEC_DONE: [
              {
                guard: and(['isCurrentExec', 'execChainComplete']),
                target: '#fiscalNote.approved',
                actions: 'markExecStepDone',
              },
              { guard: 'isCurrentExec', target: 'pending', actions: ['markExecStepDone', 'advanceExec'] },
            ],
            EXEC_RETURN: { guard: 'isCurrentExec', target: '#fiscalNote.changes_requested', actions: 'resetExec' },
          },
        },
      },
    },
    approved: { type: 'final', entry: { type: 'emit', params: { type: 'note.approved' } } },
    cancelled: { type: 'final' },
    superseded: { type: 'final' },
  },
});

export type FiscalNoteMachine = typeof fiscalNoteMachine;
export type FiscalNoteSnapshot = ReturnType<FiscalNoteMachine['resolveState']>;
export const MACHINE_VERSION = 1;
