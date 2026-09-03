import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unauthorized } from '../../lib/errors.js';
import { DEFAULT_LIMIT, MAX_LIMIT, PublishedService } from './service.js';

const UserRefSchema = z.object({ userId: z.string(), displayName: z.string() });

export const PublishedItemSchema = z.object({
  revisionId: z.string(),
  bill: z.object({ biennium: z.string(), billId: z.string(), number: z.string(), title: z.string() }),
  versionCode: z.string(),
  versionLabel: z.string(),
  title: z.string(),
  publishedAt: z.string(),
  publishedBy: UserRefSchema,
  publishedVersion: z.number(),
  exports: z.object({ pdf: z.string(), docx: z.string(), html: z.string(), xml: z.string() }),
});

export const PublishedListSchema = z.object({
  items: z.array(PublishedItemSchema),
  nextCursor: z.string().nullable(),
});

export const PublishedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
});

/** Signed-in users of any role; anonymous callers when PUBLISHED_PUBLIC is set. */
export function publishedAccess(app: FastifyInstance) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.principal && !app.config.PUBLISHED_PUBLIC) throw unauthorized();
  };
}

export async function publishedRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = new PublishedService(app.db, app.config.PUBLIC_API_ORIGIN);

  r.get(
    '/published',
    {
      schema: {
        tags: ['published'],
        summary: 'Published fiscal notes, newest first, with export URLs. Paged by limit and cursor.',
        querystring: PublishedQuerySchema,
        response: { 200: PublishedListSchema },
      },
      preHandler: publishedAccess(app),
    },
    async (req) => svc.list(req.query),
  );
}
