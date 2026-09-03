// Workflow state of a note revision, read through the workflow module's API. Until that module is registered
// the note's own drafter assignment stands in, with the state `in_progress`.
import type { FastifyInstance } from 'fastify';
import type { WorkflowState } from '@wa-leg/workflow-machine';
import { internalCall } from '../../lib/internal.js';

export interface NoteState {
  state: WorkflowState;
  drafterId: string | null;
  reviewerId: string | null;
  execChain: { userId: string; division?: string }[];
  execIndex: number;
  version?: number;
  instanceId?: string;
  supersededBy?: string | null;
  deadlines?: { kind: string; dueAt: string; warnAt?: string }[];
}

export async function readNoteState(app: FastifyInstance, noteRevisionId: string, fallbackDrafterId: string | null): Promise<NoteState> {
  if (app.hasDecorator('workflowSvc')) {
    try {
      const w = await internalCall<{ state: WorkflowState; drafterId: string | null; reviewerId: string | null; execChain: { userId: string; division?: string }[]; execIndex: number; version: number; instanceId: string; supersededBy?: string | null; deadlines?: { kind: string; dueAt: string; warnAt?: string }[] }>(app, `/notes/${noteRevisionId}/workflow`);
      return { state: w.state, drafterId: w.drafterId, reviewerId: w.reviewerId, execChain: w.execChain ?? [], execIndex: w.execIndex ?? 0, version: w.version, instanceId: w.instanceId, supersededBy: w.supersededBy ?? null, deadlines: w.deadlines ?? [] };
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  return { state: 'in_progress', drafterId: fallbackDrafterId, reviewerId: null, execChain: [], execIndex: 0 };
}
