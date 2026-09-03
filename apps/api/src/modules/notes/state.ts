// Workflow state of a note revision, read from the workflow module. A revision without an instance is a draft
// with the revision's own drafter.
import type { FastifyInstance } from 'fastify';
import type { WorkflowState } from '@wa-leg/workflow-machine';

export interface NoteState {
  state: WorkflowState;
  drafterId: string | null;
  reviewerId: string | null;
  version?: number;
  instanceId?: string;
}

export async function readNoteState(app: FastifyInstance, noteRevisionId: string, fallbackDrafterId: string | null): Promise<NoteState> {
  const row = app.hasDecorator('workflowSvc') ? await app.workflowSvc.instanceByNote(noteRevisionId) : null;
  if (row) return { state: row.state, drafterId: row.drafter_id, reviewerId: row.reviewer_id, version: row.version, instanceId: row.id };
  return { state: 'draft', drafterId: fallbackDrafterId, reviewerId: null };
}
