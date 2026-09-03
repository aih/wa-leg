import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { NotesService } from './service.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { can } from '../identity/can.js';
import { writeAudit } from '../../lib/audit.js';

const AnyObject = z.looseObject({});
const noteId = z.object({ id: z.string().uuid() });

const RequestSchema = z.object({
  requestId: z.string().optional(),
  requestedAt: z.string().optional(),
  requestedBy: z.string().optional(),
  legContact: z.object({ name: z.string().optional(), phone: z.string().optional() }).optional(),
  tenYearRequested: z.boolean().optional(),
});

export const NoteRevisionSummarySchema = z.looseObject({
  noteRevisionId: z.string(),
  noteId: z.string(),
  billKey: z.string(),
  versionCode: z.string(),
  versionLabel: z.string(),
  kind: z.enum(['note', 'estimate']),
  state: z.string(),
  drafterStatus: z.string(),
  reviewerStatus: z.string(),
  headVersion: z.number(),
  editable: z.boolean(),
});

export function notesRoutes(svc: NotesService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/notes',
      {
        schema: {
          tags: ['notes'],
          summary: 'Create a note and its first revision for a bill version (or amendment)',
          body: z.object({
            billKey: z.string(),
            versionCode: z.string(),
            amendmentId: z.string().optional(),
            kind: z.enum(['note', 'estimate']).default('note'),
            templateId: z.string().optional(),
            cloneFromRevisionId: z.string().uuid().optional(),
            request: RequestSchema.optional(),
            confidential: z.boolean().default(false),
            drafterId: z.string().optional(),
            priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          }),
          response: { 201: NoteRevisionSummarySchema },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => reply.code(201).send((await svc.create(req.principal!, req.body, req.id)) as never),
    );

    r.get(
      '/notes',
      {
        schema: { tags: ['notes'], summary: 'List note revisions visible to the caller', querystring: z.object({ billKey: z.string().optional(), state: z.string().optional(), assignee: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: z.array(NoteRevisionSummarySchema) } },
        preHandler: app.requireAuth,
      },
      async (req) => (await svc.listVisible(req.principal!, req.query)) as never,
    );

    r.get(
      '/bills/:biennium/:id/notes',
      { schema: { tags: ['notes'], summary: 'Note revisions on this bill visible to the caller, grouped by version', params: z.object({ biennium: z.string(), id: z.string() }), response: { 200: z.array(NoteRevisionSummarySchema) } }, preHandler: app.requireAuth },
      async (req) => (await svc.forBill(req.principal!, `WA:${req.params.biennium}:${req.params.id.toUpperCase()}`)) as never,
    );

    r.get(
      '/notes/:id',
      { schema: { tags: ['notes'], summary: 'Note revision summary (bill, version, request, workflow state, deadlines, assignees)', params: noteId, response: { 200: NoteRevisionSummarySchema } }, preHandler: app.requireAuth },
      async (req) => {
        const ctx = await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return (await svc.summary(req.params.id, ctx)) as never;
      },
    );

    r.patch(
      '/notes/:id',
      { schema: { tags: ['notes'], summary: 'Update metadata (confidential flag, priority, request fields, identifier override per B.RFA.03)', params: noteId, body: z.object({ confidential: z.boolean().optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), identifier: z.string().optional(), request: RequestSchema.optional() }), response: { 200: NoteRevisionSummarySchema } }, preHandler: app.requireAuth },
      async (req) => (await svc.patch(req.principal!, req.params.id, req.body, req.id)) as never,
    );

    r.get(
      '/notes/:id/context',
      { schema: { tags: ['notes'], summary: 'Template token context for this note revision', params: noteId, response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return (await svc.templateContext(req.params.id, req.principal!)) as unknown as Record<string, unknown>;
      },
    );

    r.post(
      '/notes/:id/revisions',
      { schema: { tags: ['notes'], summary: 'Create the next revision for a new bill version or amendment, cloning the document', params: noteId, body: z.object({ versionCode: z.string(), amendmentId: z.string().optional() }), response: { 201: NoteRevisionSummarySchema } }, preHandler: app.requireAuth },
      async (req, reply) => reply.code(201).send((await svc.createRevision(req.principal!, req.params.id, req.body, req.id)) as never),
    );

    r.get(
      '/notes/:id/document',
      { schema: { tags: ['notes'], summary: 'Head document', params: noteId, response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req, reply) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        const d = await svc.getDocument(req.params.id);
        reply.header('etag', `"${d.version}"`);
        reply.header('cache-control', 'no-store');
        return d as unknown as Record<string, unknown>;
      },
    );

    r.put(
      '/notes/:id/document',
      {
        schema: {
          tags: ['notes'],
          summary: 'Save head document (autosave). Requires If-Match with the current version.',
          params: noteId,
          querystring: z.object({ force: z.union([z.boolean(), z.string()]).optional() }),
          body: z.object({ doc: AnyObject, mode: z.enum(['limited', 'full']), clientId: z.string().optional() }),
          response: { 200: AnyObject, 403: AnyObject, 412: AnyObject },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => {
        const ifMatch = req.headers['if-match'];
        if (!ifMatch || Array.isArray(ifMatch)) throw badRequest('if_match_required', 'If-Match header with the current version is required');
        const force = req.query.force === true || req.query.force === 'true';
        const res = await svc.saveDocument(req.principal!, req.params.id, ifMatch, req.body as never, force, req.id);
        reply.header('etag', `"${res.version}"`);
        return res as unknown as Record<string, unknown>;
      },
    );

    r.get(
      '/notes/:id/versions',
      { schema: { tags: ['notes'], summary: 'Document versions (autosave heads and named snapshots)', params: noteId, response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return svc.listVersions(req.params.id);
      },
    );

    r.post(
      '/notes/:id/versions',
      { schema: { tags: ['notes'], summary: 'Name a snapshot of the head', params: noteId, body: z.object({ label: z.string().optional() }).default({}), response: { 201: z.object({ version: z.number() }) } }, preHandler: app.requireAuth },
      async (req, reply) => reply.code(201).send(await svc.snapshot(req.principal!, req.params.id, req.body.label, req.id)),
    );

    r.get(
      '/notes/:id/versions/:v',
      { schema: { tags: ['notes'], summary: 'A stored document version', params: noteId.extend({ v: z.coerce.number().int() }), response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return (await svc.getDocument(req.params.id, req.params.v)) as unknown as Record<string, unknown>;
      },
    );

    r.post(
      '/notes/:id/versions/:v/restore',
      { schema: { tags: ['notes'], summary: 'Restore a version as the new head', params: noteId.extend({ v: z.coerce.number().int() }), response: { 201: z.object({ version: z.number() }) } }, preHandler: app.requireAuth },
      async (req, reply) => reply.code(201).send(await svc.restore(req.principal!, req.params.id, req.params.v, req.id)),
    );

    r.get(
      '/notes/:id/diff',
      { schema: { tags: ['notes'], summary: 'Redline between two document versions plus a table-cell diff', params: noteId, querystring: z.object({ from: z.coerce.number().int(), to: z.coerce.number().int() }), response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return (await svc.diff(req.params.id, req.query.from, req.query.to)) as unknown as Record<string, unknown>;
      },
    );

    r.get(
      '/notes/:id/validate',
      { schema: { tags: ['notes'], summary: 'Validate the head document (required slots, table reconciliation)', params: noteId, response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return (await svc.validate(req.params.id)) as unknown as Record<string, unknown>;
      },
    );

    r.post(
      '/notes/:id/lock',
      { schema: { tags: ['notes'], summary: 'Acquire a soft edit lock', params: noteId, response: { 200: AnyObject, 409: AnyObject } }, preHandler: app.requireAuth },
      async (req) => (await svc.lock(req.principal!, req.params.id)) as unknown as Record<string, unknown>,
    );
    r.get(
      '/notes/:id/lock',
      { schema: { tags: ['notes'], summary: 'Current lock holder', params: noteId, response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return { lock: await svc.lockStatus(req.params.id) };
      },
    );
    r.delete(
      '/notes/:id/lock',
      { schema: { tags: ['notes'], summary: 'Release the lock', params: noteId, response: { 204: z.null() } }, preHandler: app.requireAuth },
      async (req, reply) => {
        await svc.unlock(req.principal!, req.params.id);
        return reply.code(204).send(null);
      },
    );

    r.get(
      '/notes/:id/comments',
      { schema: { tags: ['notes'], summary: 'Comment threads', params: noteId, response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return svc.listComments(req.params.id);
      },
    );
    r.post(
      '/notes/:id/comments',
      { schema: { tags: ['notes'], summary: 'Open a thread anchored to a range', params: noteId, body: z.object({ anchorText: z.string(), body: z.string().min(1), id: z.string().optional() }), response: { 201: z.object({ id: z.string() }) } }, preHandler: app.requireAuth },
      async (req, reply) => reply.code(201).send(await svc.createComment(req.principal!, req.params.id, req.body, req.id)),
    );
    r.patch(
      '/notes/:id/comments/:cid',
      { schema: { tags: ['notes'], summary: 'Resolve or reopen a thread', params: noteId.extend({ cid: z.string() }), body: z.object({ status: z.enum(['open', 'resolved']) }), response: { 200: z.object({ ok: z.boolean() }) } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.setCommentStatus(req.principal!, req.params.id, req.params.cid, req.body.status, req.id);
        return { ok: true };
      },
    );
    r.delete(
      '/notes/:id/comments/:cid',
      { schema: { tags: ['notes'], summary: 'Delete a thread (author or reviewer)', params: noteId.extend({ cid: z.string() }), response: { 204: z.null() } }, preHandler: app.requireAuth },
      async (req, reply) => {
        await svc.deleteComment(req.principal!, req.params.id, req.params.cid, req.id);
        return reply.code(204).send(null);
      },
    );
    r.post(
      '/notes/:id/comments/:cid/messages',
      { schema: { tags: ['notes'], summary: 'Reply in a thread', params: noteId.extend({ cid: z.string() }), body: z.object({ body: z.string().min(1) }), response: { 201: z.object({ id: z.string() }) } }, preHandler: app.requireAuth },
      async (req, reply) => reply.code(201).send(await svc.reply(req.principal!, req.params.id, req.params.cid, req.body.body, req.id)),
    );

    // ---- exports ----
    const exportQuery = z.object({ format: z.enum(['html', 'pdf', 'docx', 'xml']), version: z.coerce.number().int().optional(), comments: z.union([z.boolean(), z.string()]).optional(), strict: z.union([z.boolean(), z.string()]).optional() });
    const sendExport = async (reply: FastifyReply, res: { filename: string; contentType: string; body: Buffer; exportId: string; version: number }, inline: boolean) => {
      reply.header('content-type', res.contentType);
      reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${res.filename}"`);
      reply.header('x-export-id', res.exportId);
      reply.header('x-document-version', String(res.version));
      reply.header('cache-control', 'no-store');
      return reply.send(res.body);
    };
    const truthy = (v: boolean | string | undefined) => v === true || v === 'true';
    for (const method of ['POST', 'GET'] as const) {
      r.route({
        method,
        url: '/notes/:id/export',
        schema: { tags: ['notes'], summary: method === 'POST' ? 'Export a document version as docx, pdf, xml (FNS placeholder), or html' : 'Export (link form: opens in the browser)', params: noteId, querystring: exportQuery, response: { 422: AnyObject } },
        preHandler: app.requireAuth,
        handler: async (req, reply) => {
          const q = req.query as z.infer<typeof exportQuery>;
          const res = await svc.exports.export(req.principal!, (req.params as { id: string }).id, { format: q.format, version: q.version, comments: truthy(q.comments), strict: truthy(q.strict) }, req.id);
          return sendExport(reply, res, method === 'GET' && (q.format === 'pdf' || q.format === 'html'));
        },
      });
    }
    r.get(
      '/notes/:id/exports',
      { schema: { tags: ['notes'], summary: 'Stored exports of this revision', params: noteId, response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
      async (req) => svc.exports.list(req.principal!, req.params.id, req.id),
    );
    r.get(
      '/notes/:id/exports/:exportId',
      { schema: { tags: ['notes'], summary: 'Download a stored export', params: noteId.extend({ exportId: z.string().uuid() }) }, preHandler: app.requireAuth },
      async (req, reply) => sendExport(reply, await svc.exports.stored(req.principal!, req.params.id, req.params.exportId, req.id), false),
    );
    r.get(
      '/export-jobs/:jobId',
      { schema: { tags: ['notes'], summary: 'Export job status (exports run synchronously; the job is the stored export)', params: z.object({ jobId: z.string().uuid() }), response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => svc.exports.job(req.principal!, req.params.jobId) as unknown as Record<string, unknown>,
    );

    // Audit of one note (participants see their own note's history).
    r.get(
      '/notes/:id/audit',
      { schema: { tags: ['notes'], summary: 'Audit rows for this note revision', params: noteId, response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
      async (req) => {
        const ctx = await svc.resource(req.params.id);
        if (!can(req.principal!, 'audit.read', ctx.res)) {
          await writeAudit(app.db, { actorId: req.principal!.userId, action: 'permission.denied', objectType: 'note_revision', objectId: req.params.id, after: { action: 'audit.read' }, requestId: req.id });
          throw forbidden();
        }
        const rows = (await app.db.execute((await import('drizzle-orm')).sql`SELECT id, actor_id, action, object_type, object_id, before, after, request_id, at FROM audit_log WHERE object_id = ${req.params.id} ORDER BY at DESC, id DESC LIMIT 500`)).rows as any[];
        return rows.map((row) => ({ id: Number(row.id), actorId: row.actor_id, action: row.action, objectType: row.object_type, objectId: row.object_id, before: row.before ?? null, after: row.after ?? null, requestId: row.request_id ?? null, at: new Date(row.at).toISOString() }));
      },
    );
  };
}
