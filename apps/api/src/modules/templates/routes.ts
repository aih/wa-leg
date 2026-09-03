import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { can } from '../identity/can.js';
import { forbidden } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/outbox.js';
import { loadTemplate, docToHtml } from '@wa-leg/note-schema';
import { internalCall } from '../../lib/internal.js';

const SlotSchema = z.object({ id: z.string(), required: z.boolean(), hint: z.string().optional() });
export const TemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['document', 'snippet']),
  mode: z.enum(['limited', 'full']),
  version: z.number(),
  description: z.string(),
  file: z.string().optional(),
  tags: z.array(z.string()),
  parts: z.array(z.string()),
  tables: z.array(z.string()),
  slots: z.array(SlotSchema),
  tokens: z.array(z.string()),
  updatedAt: z.string(),
});
export const TemplateSchema = TemplateSummarySchema.extend({ html: z.string(), etag: z.string() });

export async function templatesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.templates;

  r.get(
    '/templates',
    {
      schema: { tags: ['templates'], summary: 'List templates', querystring: z.object({ mode: z.enum(['limited', 'full']).optional(), kind: z.enum(['document', 'snippet']).optional(), taxType: z.string().optional(), impactType: z.string().optional(), q: z.string().optional() }), response: { 200: z.array(TemplateSummarySchema) } },
      preHandler: app.requireAuth,
    },
    async (req) => svc.list(req.query),
  );

  r.get(
    '/templates/:id',
    { schema: { tags: ['templates'], summary: 'Template with HTML body', params: z.object({ id: z.string() }), querystring: z.object({ version: z.coerce.number().int().optional() }), response: { 200: TemplateSchema } }, preHandler: app.requireAuth },
    async (req, reply) => {
      const t = await svc.get(req.params.id, req.query.version);
      reply.header('etag', t.etag);
      return t;
    },
  );

  r.put(
    '/templates/:id',
    {
      schema: { tags: ['templates'], summary: 'Update a template (template_editor role); creates a new template version', params: z.object({ id: z.string() }), body: z.object({ name: z.string().optional(), description: z.string().optional(), html: z.string().optional(), tags: z.array(z.string()).optional(), kind: z.enum(['document', 'snippet']).optional(), mode: z.enum(['limited', 'full']).optional() }), response: { 200: TemplateSchema } },
      preHandler: app.requireAuth,
    },
    async (req) => {
      const p = req.principal!;
      if (!can(p, 'template.edit')) {
        await writeAudit(app.db, { actorId: p.userId, action: 'permission.denied', objectType: 'template', objectId: req.params.id, requestId: req.id });
        throw forbidden();
      }
      const before = await svc.get(req.params.id);
      const after = await svc.update(req.params.id, req.body, p.userId);
      await app.db.transaction(async (tx) => {
        await writeAudit(tx, { actorId: p.userId, action: 'template.update', objectType: 'template', objectId: req.params.id, before: { version: before.version }, after: { version: after.version }, requestId: req.id });
        await emitEvent(tx, 'template.updated', { templateId: after.id, version: after.version });
      });
      return after;
    },
  );

  r.get(
    '/templates/:id/preview',
    { schema: { tags: ['templates'], summary: "Template rendered with a note's token context", params: z.object({ id: z.string() }), querystring: z.object({ noteId: z.string().optional() }) }, preHandler: app.requireAuth },
    async (req, reply) => {
      const t = await svc.get(req.params.id);
      const ctx = req.query.noteId
        ? await internalCall<Record<string, unknown>>(app, `/notes/${req.query.noteId}/context`, { as: req.principal! })
        : await internalCall<Record<string, unknown>>(app, `/reference/template-context`, { as: req.principal! });
      const loaded = loadTemplate(t.html, ctx as never, { mode: t.mode });
      reply.type('text/html; charset=utf-8');
      return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t.name}</title></head><body>${docToHtml(loaded.doc, { mode: t.mode })}</body></html>`;
    },
  );
}
