import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

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
}
