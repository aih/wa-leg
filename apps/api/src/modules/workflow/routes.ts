import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { BUTTON_EVENTS } from '@wa-leg/workflow-machine';
import type { WorkflowService } from './service.js';
import { internalCall } from '../../lib/internal.js';
import { SYSTEM_PRINCIPAL } from '../identity/index.js';
import { can } from '../identity/can.js';
import { forbidden } from '../../lib/errors.js';

const AnyObject = z.looseObject({});
const noteId = z.object({ id: z.string().uuid() });

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
      { schema: { tags: ['workflow'], summary: 'Workflow state, assignees, available events for the caller, deadlines', params: noteId, response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        await assertVisible(req, req.params.id);
        return (await svc.view(req.params.id, req.principal!)) as unknown as Record<string, unknown>;
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

    r.post(
      '/notes/:id/transitions',
      {
        schema: {
          tags: ['workflow'],
          summary: 'Send an event to the machine',
          params: noteId,
          body: z.object({ event: z.enum(BUTTON_EVENTS), comment: z.string().optional(), expectedVersion: z.number().int().optional() }),
          response: { 201: z.object({ instanceId: z.string(), state: z.string(), version: z.number(), seq: z.number() }), 409: AnyObject },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => {
        await assertVisible(req, req.params.id);
        return reply.code(201).send(await svc.transition(req.principal!, req.params.id, req.body, req.id));
      },
    );

    r.post(
      '/notes/:id/assign',
      { schema: { tags: ['workflow'], summary: 'Assign or reassign a role', params: noteId, body: z.object({ role: z.enum(['drafter', 'reviewer', 'exec']), userId: z.string(), position: z.number().int().optional(), dueAt: z.string().optional() }), response: { 200: AnyObject, 409: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        if (!can(req.principal!, 'note.assign')) throw forbidden('Only assigners may assign');
        return (await svc.assign(req.principal!, req.params.id, req.body, req.id)) as unknown as Record<string, unknown>;
      },
    );

    r.put(
      '/notes/:id/exec-chain',
      { schema: { tags: ['workflow'], summary: 'Set the Executive Review chain', params: noteId, body: z.object({ chain: z.array(z.object({ userId: z.string(), division: z.string().optional(), dueAt: z.string().nullable().optional() })) }), response: { 200: AnyObject, 409: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        if (!can(req.principal!, 'note.assign')) throw forbidden('Only assigners may set the chain');
        return (await svc.setExecChain(req.principal!, req.params.id, req.body.chain, req.id)) as unknown as Record<string, unknown>;
      },
    );

    r.post(
      '/notes/:id/workflow/duplicate',
      { schema: { tags: ['workflow'], summary: 'Duplicate the task for another revision (new instance in todo with the same assignments)', params: noteId, body: z.object({ noteRevisionId: z.string().uuid() }), response: { 201: AnyObject } }, preHandler: app.requireAuth },
      async (req, reply) => {
        if (!can(req.principal!, 'note.duplicate')) throw forbidden('Only assigners may duplicate');
        return reply.code(201).send((await svc.duplicate(req.principal!, req.params.id, req.body.noteRevisionId, req.id)) as unknown as Record<string, unknown>);
      },
    );

    r.get(
      '/assignments',
      {
        schema: {
          tags: ['workflow'],
          summary: 'Work queue rows for the caller (or, for assigners, another user or everyone)',
          querystring: z.object({ assignee: z.string().optional(), role: z.enum(['drafter', 'reviewer', 'exec']).optional(), status: z.string().optional(), state: z.string().optional(), dueBefore: z.string().optional(), limit: z.coerce.number().int().optional(), all: z.union([z.boolean(), z.string()]).optional() }),
          response: { 200: z.array(AnyObject) },
        },
        preHandler: app.requireAuth,
      },
      async (req) => (await svc.assignments(req.principal!, { ...req.query, all: req.query.all === true || req.query.all === 'true' })) as unknown as Record<string, unknown>[],
    );

    r.get(
      '/workflow/summary',
      { schema: { tags: ['workflow'], summary: 'Counts by state for dashboards', querystring: z.object({ state: z.string().optional(), drafter: z.string().optional(), reviewer: z.string().optional() }), response: { 200: z.record(z.string(), z.number()) } }, preHandler: app.requireAuth },
      async (req) => svc.summary(req.query),
    );

    r.get(
      '/workflow/unassigned-hearings',
      { schema: { tags: ['workflow'], summary: 'Bills with a hearing inside the window and no note', querystring: z.object({ withinHours: z.coerce.number().int().default(72) }), response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
      async (req) => {
        if (!can(req.principal!, 'assignments.read_all')) throw forbidden();
        return (await svc.unassignedHearings(req.query.withinHours)) as unknown as Record<string, unknown>[];
      },
    );

    r.post(
      '/workflow/poll-deadlines',
      { schema: { tags: ['workflow'], summary: 'Run the deadline poller now (admin, tests)', response: { 200: z.object({ warned: z.number(), overdue: z.number() }) } }, preHandler: app.requireAuth },
      async (req) => {
        if (!can(req.principal!, 'search.reindex')) throw forbidden();
        return svc.pollDeadlines();
      },
    );
  };
}
