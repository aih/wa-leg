import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { can } from '../identity/can.js';
import { badRequest, forbidden, unavailable } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import type { SearchPipeline } from './pipeline.js';
import type { SearchIndexer } from './indexer.js';
import type { SearchBackend } from './backend.js';

const list = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined));
const bool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'));

const AnyObject = z.looseObject({});

export const SearchQuerySchema = z.object({
  q: z.string().optional(),
  biennium: z.string().optional(),
  chamber: z.enum(['H', 'S']).optional(),
  type: list,
  status: list,
  committee: z.string().optional(),
  sponsor: z.string().optional(),
  has_fiscal_note: bool,
  fiscal_note_status: list,
  doc_type: list,
  rcw: z.string().optional(),
  version_code: z.string().optional(),
  date_from: z.string().optional(),
  date_to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['relevance', 'date', 'bill_number']).optional(),
});

export function searchRoutes(deps: { pipeline: SearchPipeline; indexer: SearchIndexer; backend: SearchBackend }) {
  return async function routes(app: FastifyInstance): Promise<void> {
    // Background reindex jobs finish before the app closes (tests close the pool right after the request).
    const jobs = new Set<Promise<void>>();
    app.addHook('onClose', async () => {
      await Promise.allSettled([...jobs]);
    });
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/search',
      {
        schema: { tags: ['search'], summary: 'Text search with direct-hit resolution, filters, facets (research/search.md section 6.1)', querystring: SearchQuerySchema, response: { 200: AnyObject, 503: AnyObject } },
        preHandler: app.requireAuth,
      },
      async (req, reply) => {
        const raw = req.raw.url ?? '';
        if (/[?&](visibility|allowed_roles|allowed_user_ids)=/i.test(raw)) throw badRequest('permission_param', 'Permission fields are not accepted from the client');
        const health = await deps.backend.health();
        if (!health.ok) {
          reply.code(503);
          throw unavailable('search_unavailable', `Search backend ${deps.backend.name} is unavailable: ${health.detail ?? ''}`);
        }
        const q = req.query;
        const rcwFilters: { rcw_cites?: string[]; rcw_chapters?: string[]; rcw_titles?: string[] } = {};
        if (q.rcw) {
          const parts = q.rcw.split('.');
          if (parts.length >= 3) rcwFilters.rcw_cites = [q.rcw];
          else if (parts.length === 2) rcwFilters.rcw_chapters = [q.rcw];
          else rcwFilters.rcw_titles = [q.rcw];
        }
        const res = await deps.pipeline.search(
          {
            q: q.q,
            biennium: q.biennium,
            chamber: q.chamber,
            type: q.type,
            status: q.status,
            committee: q.committee,
            sponsor: q.sponsor,
            has_fiscal_note: q.has_fiscal_note,
            fiscal_note_status: q.fiscal_note_status,
            doc_type: q.doc_type as any,
            version_code: q.version_code,
            date_from: q.date_from,
            date_to: q.date_to,
            page: q.page,
            size: q.size,
            sort: q.sort,
            ...rcwFilters,
          },
          req.principal!,
          app.config.CURRENT_BIENNIUM,
        );
        return res as unknown as Record<string, unknown>;
      },
    );

    r.get(
      '/search/suggest',
      {
        schema: { tags: ['search'], summary: 'Search-as-you-type suggestions', querystring: z.object({ q: z.string().min(1), biennium: z.string().optional(), size: z.coerce.number().int().min(1).max(10).default(8) }), response: { 200: AnyObject } },
        preHandler: app.requireAuth,
      },
      async (req) => (await deps.pipeline.suggest(req.query.q, req.query.biennium ?? app.config.CURRENT_BIENNIUM, req.principal!, req.query.size)) as unknown as Record<string, unknown>,
    );

    r.post(
      '/search/reindex',
      {
        schema: {
          tags: ['admin'],
          summary: 'Rebuild or refresh indices (admin)',
          body: z.object({ scope: z.enum(['full', 'incremental', 'bill']).default('incremental'), bill_keys: z.array(z.string()).optional(), indices: z.array(z.string()).optional(), limit: z.number().int().optional() }).default({ scope: 'incremental' }),
          response: { 202: z.object({ job_id: z.string(), status_url: z.string() }) },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => {
        const p = req.principal!;
        if (!can(p, 'search.reindex')) {
          await writeAudit(app.db, { actorId: p.userId, action: 'permission.denied', objectType: 'search', objectId: 'reindex', requestId: req.id });
          throw forbidden();
        }
        const jobId = randomUUID();
        await writeAudit(app.db, { actorId: p.userId, action: 'search.reindex', objectType: 'search', objectId: jobId, after: req.body, requestId: req.id });
        const job: Promise<void> = (async () => {
          try {
            if (req.body.scope === 'bill' && req.body.bill_keys?.length) {
              for (const k of req.body.bill_keys) await deps.indexer.indexBill(k);
              await deps.backend.refresh();
            } else {
              await deps.backend.init();
              await deps.indexer.loadAll({ biennium: app.config.CURRENT_BIENNIUM, limit: req.body.limit });
            }
            app.log.info({ jobId }, 'reindex done');
          } catch (err) {
            app.log.error({ err, jobId }, 'reindex failed');
          }
        })().finally(() => jobs.delete(job));
        jobs.add(job);
        return reply.code(202).send({ job_id: jobId, status_url: '/api/v1/health' });
      },
    );
  };
}
