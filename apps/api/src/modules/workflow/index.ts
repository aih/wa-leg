import type { FastifyInstance } from 'fastify';
import { WorkflowService } from './service.js';
import { workflowRoutes, WorkflowViewSchema, TransitionBodySchema } from './routes.js';

export { WorkflowService, workflowRoutes, WorkflowViewSchema, TransitionBodySchema };
export type { WorkflowView, ChangeRequestView, TransitionRow, TransitionBody, TransitionOutcome, UserRef } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    workflowSvc: WorkflowService;
  }
}

/** Create the workflow service on the root instance. The notes module creates instances when it creates notes. */
export function createWorkflow(app: FastifyInstance): WorkflowService {
  const svc = new WorkflowService(app, app.db);
  app.decorate('workflowSvc', svc);
  return svc;
}
