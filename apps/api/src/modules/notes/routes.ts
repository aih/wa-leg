import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { NotesService } from './service.js';
import { badRequest, unauthorized } from '../../lib/errors.js';

const AnyObject = z.looseObject({});
const noteId = z.object({ id: z.string().uuid() });

const UserRefSchema = z.object({ userId: z.string(), displayName: z.string().optional() });

export const NoteRevisionSummarySchema = z.object({
  noteRevisionId: z.string(),
  noteId: z.string(),
  billKey: z.string(),
  biennium: z.string(),
  billId: z.string(),
  billTitle: z.string().optional(),
  versionCode: z.string(),
  versionLabel: z.string(),
  state: z.enum(['draft', 'in_review', 'changes_requested', 'approved', 'published']),
  drafter: UserRefSchema.nullable(),
  reviewer: UserRefSchema.nullable(),
  headVersion: z.number(),
  approvedVersion: z.number().nullable(),
  publishedAt: z.string().nullable(),
  publishedBy: UserRefSchema.nullable(),
  publishedVersion: z.number().nullable(),
  templateId: z.string().nullable(),
  templateVersion: z.number().nullable(),
  mode: z.enum(['limited', 'full']),
  editable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CreateNoteBodySchema = z.object({
  billKey: z.string(),
  versionCode: z.string(),
  templateId: z.string(),
  drafterId: z.string().optional(),
});

export function notesRoutes(svc: NotesService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/notes',
      {
        schema: {
          tags: ['notes'],
          summary: 'Create a note in draft for a bill version from a template. Reviewers name the drafter; a drafter creates for themselves.',
          body: CreateNoteBodySchema,
          response: { 201: NoteRevisionSummarySchema },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => reply.code(201).send(await svc.create(req.principal!, req.body, req.id)),
    );

    r.get(
      '/notes',
      {
        schema: { tags: ['notes'], summary: 'Note revisions visible to the caller', querystring: z.object({ billKey: z.string().optional(), state: z.string().optional(), assignee: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(200).default(50) }), response: { 200: z.array(NoteRevisionSummarySchema) } },
        preHandler: app.requireAuth,
      },
      async (req) => svc.listVisible(req.principal!, req.query),
    );

    r.get(
      '/bills/:biennium/:id/notes',
      { schema: { tags: ['notes'], summary: 'Note revisions on this bill visible to the caller', params: z.object({ biennium: z.string(), id: z.string() }), response: { 200: z.array(NoteRevisionSummarySchema) } }, preHandler: app.requireAuth },
      async (req) => svc.forBill(req.principal!, `WA:${req.params.biennium}:${req.params.id.toUpperCase()}`),
    );

    r.get(
      '/notes/:id',
      { schema: { tags: ['notes'], summary: 'Note revision summary (bill, version, state, drafter, reviewer, publication)', params: noteId, response: { 200: NoteRevisionSummarySchema } }, preHandler: app.requireAuth },
      async (req) => {
        const ctx = await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return svc.summary(req.params.id, ctx);
      },
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
          body: z.object({ doc: AnyObject, mode: z.enum(['limited', 'full']), clientId: z.string().optional() }),
          response: { 200: AnyObject, 403: AnyObject, 412: AnyObject },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => {
        const ifMatch = req.headers['if-match'];
        if (!ifMatch || Array.isArray(ifMatch)) throw badRequest('if_match_required', 'If-Match header with the current version is required');
        const res = await svc.saveDocument(req.principal!, req.params.id, ifMatch, req.body as never, req.id);
        reply.header('etag', `"${res.version}"`);
        return res as unknown as Record<string, unknown>;
      },
    );

    r.get(
      '/notes/:id/versions',
      { schema: { tags: ['notes'], summary: 'Document versions', params: noteId, response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return svc.listVersions(req.params.id);
      },
    );

    r.get(
      '/notes/:id/versions/:v',
      { schema: { tags: ['notes'], summary: 'A stored document version', params: noteId.extend({ v: z.coerce.number().int() }), response: { 200: AnyObject } }, preHandler: app.requireAuth },
      async (req) => {
        await svc.assertCan(req.principal!, 'note.read', req.params.id, req.id);
        return (await svc.getDocument(req.params.id, req.params.v)) as unknown as Record<string, unknown>;
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
    const exportQuery = z.object({ format: z.enum(['html', 'pdf', 'docx', 'xml']), version: z.coerce.number().int().optional(), strict: z.union([z.boolean(), z.string()]).optional() });
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
        schema: { tags: ['notes'], summary: method === 'POST' ? 'Export a document version as docx, pdf, xml (FNS placeholder), or html. Viewers and anonymous callers (PUBLISHED_PUBLIC) get the published version.' : 'Export (link form: opens in the browser)', params: noteId, querystring: exportQuery, response: { 422: AnyObject } },
        // Anonymous callers reach the published version when PUBLISHED_PUBLIC is set.
        preHandler: async (req) => {
          if (!req.principal && !app.config.PUBLISHED_PUBLIC) throw unauthorized();
        },
        handler: async (req, reply) => {
          const q = req.query as z.infer<typeof exportQuery>;
          const res = await svc.exports.export(req.principal, (req.params as { id: string }).id, { format: q.format, version: q.version, strict: truthy(q.strict) }, req.id);
          return sendExport(reply, res, method === 'GET' && (q.format === 'pdf' || q.format === 'html'));
        },
      });
    }
  };
}
