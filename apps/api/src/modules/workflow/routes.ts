import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { EVENT_TYPES } from '@wa-leg/workflow-machine';
import type { WorkflowService } from './service.js';
import { internalCall } from '../../lib/internal.js';
import { SYSTEM_PRINCIPAL } from '../identity/index.js';

const AnyObject = z.looseObject({});
const noteId = z.object({ id: z.string().uuid() });

const UserRefSchema = z.object({ userId: z.string(), displayName: z.string().optional() });

export const WorkflowViewSchema = z.object({
  instanceId: z.string(),
  noteRevisionId: z.string(),
  state: z.enum(['draft', 'in_review', 'changes_requested', 'approved', 'published']),
  version: z.number(),
  drafter: UserRefSchema.nullable(),
  reviewer: UserRefSchema.nullable(),
  availableEvents: z.array(z.object({ type: z.enum(EVENT_TYPES), label: z.string() })),
  changeRequest: z.object({ message: z.string(), by: UserRefSchema, at: z.string() }).nullable(),
  editable: z.boolean(),
  updatedAt: z.string(),
});

export const TransitionBodySchema = z.object({
  event: z.enum(EVENT_TYPES),
  message: z.string().optional(),
  expectedVersion: z.number().int().optional(),
});

export function workflowRoutes(svc: WorkflowService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    /** The notes module enforces `note.read`; the system principal (used by that module) skips the round trip. */
    const assertVisible = async (req: { principal?: { userId: string } | null }, id: string) => {
      if (req.principal?.userId === SYSTEM_PRINCIPAL.userId) return;
      await internalCall(app, `/notes/${id}`, { as: req.principal as never });
    };

    r.get(
      '/notes/:id/workflow',
      { schema: { tags: ['workflow'], summary: 'Workflow state, drafter, reviewer, events available to the caller, open change request', params: noteId, response: { 200: WorkflowViewSchema } }, preHandler: app.requireAuth },
      async (req) => {
        await assertVisible(req, req.params.id);
        return svc.view(req.params.id, req.principal!);
      },
    );

    r.post(
      '/notes/:id/workflow',
      {
        schema: {
          tags: ['workflow'],
          summary: 'Send an event: SUBMIT, REQUEST_CHANGES (message required), APPROVE, PUBLISH',
          params: noteId,
          body: TransitionBodySchema,
          response: { 201: z.object({ instanceId: z.string(), state: z.string(), version: z.number(), seq: z.number() }), 409: AnyObject },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => {
        await assertVisible(req, req.params.id);
        return reply.code(201).send(await svc.transition(req.principal!, req.params.id, req.body, req.id));
      },
    );

    r.get(
      '/notes/:id/transitions',
      { schema: { tags: ['workflow'], summary: 'Transition history (newest first)', params: noteId, querystring: z.object({ limit: z.coerce.number().int().optional(), before: z.coerce.number().int().optional() }), response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
      async (req) => {
        await assertVisible(req, req.params.id);
        return (await svc.transitions(req.params.id, req.query)) as unknown as Record<string, unknown>[];
      },
    );
  };
}
