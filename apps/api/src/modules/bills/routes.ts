import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BillsService } from './service.js';
import { can } from '../identity/can.js';
import { forbidden } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { CachingFetcher } from './ingest/lawfiles.js';
import { finishIngestRun, ingestLegiscanBills, readDataset, recordIngestRun, refreshDocuments } from './ingest/legiscan.js';
import type { Logger } from 'pino';

const biennium = z.string().regex(/^\d{4}-\d{2}$/);
const billId = z.string().regex(/^[HS](B|JR|JM|CR|R|I)\d{1,5}$/i);

export const HearingSchema = z.object({
  id: z.string(),
  billKey: z.string(),
  versionCode: z.string().optional(),
  committee: z.string(),
  chamber: z.string().optional(),
  kind: z.string(),
  hearingAt: z.string(),
  location: z.string().optional(),
  description: z.string().optional(),
  cancelled: z.boolean(),
  hasNote: z.boolean().optional(),
});

const VersionRowSchema = z.object({
  code: z.string(),
  label: z.string(),
  shortLabel: z.string(),
  seq: z.number(),
  status: z.string(),
  date: z.string().optional(),
  amendmentIds: z.array(z.string()),
  sourceUrls: z.object({ xml: z.string().optional(), pdf: z.string().optional(), htm: z.string().optional() }),
});

export const BillSummarySchema = z.object({
  billKey: z.string(),
  biennium: z.string(),
  id: z.string(),
  type: z.string(),
  number: z.number(),
  chamber: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string().optional(),
  statusDate: z.string().optional(),
  sponsors: z.array(z.unknown()),
  committee: z.unknown().optional(),
  currentVersionCode: z.string(),
  versions: z.array(VersionRowSchema),
  hearings: z.array(HearingSchema),
  priorFiscalNotes: z.array(
    z.object({ id: z.string(), packageId: z.number().optional(), label: z.string(), versionLabel: z.string().optional(), kind: z.string().optional(), url: z.string(), publishedAt: z.string().optional() }),
  ),
  companion: z.object({ billKey: z.string(), id: z.string(), title: z.string().optional() }).nullable().optional(),
  rcwAffected: z.array(z.unknown()),
  history: z.array(z.unknown()),
  updatedAt: z.string(),
});

const AmendmentSummarySchema = z.object({
  amendmentId: z.string(),
  kind: z.string(),
  scope: z.string().optional(),
  chamber: z.string().optional(),
  sponsor: z.string().optional(),
  baseVersionCode: z.string(),
  adopted: z.boolean(),
  floorAction: z.string().optional(),
  date: z.string().optional(),
  status: z.string(),
  effect: z.string().optional(),
  drafterCode: z.string().optional(),
  floorNumber: z.string().optional(),
  pdfUrl: z.string().optional(),
});

/** Bill Document and diff payloads are large and specified by the bill-document JSON Schemas; passed through. */
const BillDocumentSchema = z.looseObject({ schemaVersion: z.string(), bill: z.looseObject({}), version: z.looseObject({}), header: z.looseObject({}), sections: z.array(z.looseObject({})), provenance: z.looseObject({}) }).describe('Bill Document (packages/bill-document/schemas/bill-document.json)');
const VersionDiffSchema = z.looseObject({ bill: z.looseObject({}), from: z.string(), to: z.string(), mode: z.string(), sections: z.array(z.looseObject({})), summary: z.looseObject({}) }).describe('VersionDiff (design/research/bill-viewer.md section 5)');
const AnyObject = z.looseObject({});

export async function billsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.bills;
  const params = z.object({ biennium, id: billId });

  r.get(
    '/bills/resolve',
    {
      schema: { tags: ['bills'], summary: 'Parse a bill reference and resolve it to a bill and version', querystring: z.object({ ref: z.string().min(1), biennium: biennium.optional() }), response: { 200: AnyObject, 404: AnyObject } },
      preHandler: app.requireAuth,
    },
    async (req, reply) => {
      const res = await svc.resolve(req.query.ref, { currentBiennium: req.query.biennium ?? app.config.CURRENT_BIENNIUM });
      if ((res as { notFound?: boolean }).notFound && !(res as { ambiguous?: boolean }).ambiguous) return reply.code(404).send(res);
      return res;
    },
  );

  r.get(
    '/bills',
    {
      schema: {
        tags: ['bills'],
        summary: 'List bills (paged)',
        querystring: z.object({ biennium: z.string().optional(), q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), size: z.coerce.number().int().min(1).max(500).default(50) }),
        response: { 200: z.array(z.object({ billKey: z.string(), id: z.string(), biennium: z.string(), title: z.string(), status: z.string().nullable(), currentVersionCode: z.string().nullable(), updatedAt: z.string() })) },
      },
      preHandler: app.requireAuth,
    },
    async (req) => svc.listBills(req.query),
  );

  r.get(
    '/bills/:biennium/:id',
    { schema: { tags: ['bills'], summary: 'Bill summary with version list, hearings, prior fiscal notes, companion', params, response: { 200: BillSummarySchema } }, preHandler: app.requireAuth },
    async (req, reply) => {
      reply.header('cache-control', 'no-cache');
      return (await svc.getBill(req.params.biennium, req.params.id.toUpperCase())) as unknown as z.infer<typeof BillSummarySchema>;
    },
  );

  r.get(
    '/bills/:biennium/:id/versions/:code',
    { schema: { tags: ['bills'], summary: 'Bill Document for one version (code=current resolves to the newest)', params: params.extend({ code: z.string() }), response: { 200: BillDocumentSchema } }, preHandler: app.requireAuth },
    async (req, reply) => {
      const { document, resolvedCode, explicit } = await svc.getVersion(req.params.biennium, req.params.id.toUpperCase(), req.params.code);
      reply.header('cache-control', explicit ? 'private, max-age=3600, immutable' : 'no-cache');
      return { ...document, resolvedCode } as unknown as z.infer<typeof BillDocumentSchema>;
    },
  );

  r.get(
    '/bills/:biennium/:id/versions/:code/sections/:sectionId',
    { schema: { tags: ['bills'], summary: 'One section of a version', params: params.extend({ code: z.string(), sectionId: z.string() }), response: { 200: AnyObject } }, preHandler: app.requireAuth },
    async (req) => (await svc.getSection(req.params.biennium, req.params.id.toUpperCase(), req.params.code, req.params.sectionId)) as unknown as Record<string, unknown>,
  );

  r.get(
    '/bills/:biennium/:id/diff',
    {
      schema: {
        tags: ['bills'],
        summary: 'Version-to-version diff (to may be amend:{amendmentId} for a striking amendment)',
        params,
        querystring: z.object({ from: z.string(), to: z.string(), mode: z.enum(['as-printed', 'effect']).default('as-printed') }),
        response: { 200: VersionDiffSchema },
      },
      preHandler: app.requireAuth,
    },
    async (req, reply) => {
      reply.header('cache-control', 'private, max-age=3600');
      return (await svc.diff(req.params.biennium, req.params.id.toUpperCase(), req.query.from, req.query.to, req.query.mode)) as unknown as z.infer<typeof VersionDiffSchema>;
    },
  );

  r.get(
    '/bills/:biennium/:id/amendments',
    { schema: { tags: ['bills'], summary: 'Amendments of a bill', params, response: { 200: z.array(AmendmentSummarySchema) } }, preHandler: app.requireAuth },
    async (req) => svc.listAmendments(req.params.biennium, req.params.id.toUpperCase()),
  );

  r.get(
    '/bills/:biennium/:id/amendments/:amendmentId',
    { schema: { tags: ['bills'], summary: 'Amendment Document', params: params.extend({ amendmentId: z.string() }), response: { 200: AnyObject } }, preHandler: app.requireAuth },
    async (req, reply) => {
      reply.header('cache-control', 'private, max-age=3600, immutable');
      return (await svc.getAmendment(req.params.biennium, req.params.id.toUpperCase(), req.params.amendmentId)) as unknown as Record<string, unknown>;
    },
  );

  r.get(
    '/bills/:biennium/:id/hearings',
    { schema: { tags: ['bills'], summary: 'Hearings and executive sessions', params, response: { 200: z.array(HearingSchema) } }, preHandler: app.requireAuth },
    async (req) => (await svc.listHearings(svc.billKey(req.params.biennium, req.params.id.toUpperCase()))) as z.infer<typeof HearingSchema>[],
  );

  // ---- admin: ingest ----
  r.get(
    '/admin/ingest/runs',
    { schema: { tags: ['admin'], summary: 'Ingest run history', response: { 200: z.array(AnyObject) } }, preHandler: app.requireAuth },
    async (req) => {
      if (!can(req.principal!, 'ingest.run')) throw forbidden();
      return svc.listIngestRuns();
    },
  );

  r.post(
    '/admin/ingest/runs',
    {
      schema: {
        tags: ['admin'],
        summary: 'Start an ingest run (legiscan dataset path or refresh)',
        body: z.object({ source: z.enum(['legiscan', 'refresh']).default('refresh'), path: z.string().optional(), billKeys: z.array(z.string()).optional(), limit: z.number().int().optional() }),
        response: { 202: z.object({ job_id: z.string(), status_url: z.string() }) },
      },
      preHandler: app.requireAuth,
    },
    async (req, reply) => {
      const p = req.principal!;
      if (!can(p, 'ingest.run')) {
        await writeAudit(app.db, { actorId: p.userId, action: 'permission.denied', objectType: 'ingest', objectId: '*', requestId: req.id });
        throw forbidden();
      }
      const id = randomUUID();
      await recordIngestRun(app.db, { id, source: req.body.source, path: req.body.path, requestedBy: p.userId });
      await writeAudit(app.db, { actorId: p.userId, action: 'ingest.start', objectType: 'ingest_run', objectId: id, after: req.body, requestId: req.id });
      const deps = { db: app.db, fetcher: new CachingFetcher(app.config.LAWFILES_CACHE_DIR), log: app.log as unknown as Logger };
      void (async () => {
        try {
          const stats =
            req.body.source === 'legiscan'
              ? await ingestLegiscanBills(deps, readDataset(req.body.path ?? app.config.LEGISCAN_DIR, { limit: req.body.limit, bills: req.body.billKeys?.map((k) => k.split(':').pop()!) }), {})
              : await refreshDocuments(deps, { billKeys: req.body.billKeys });
          await finishIngestRun(app.db, id, 'done', stats);
          app.bus.kick();
        } catch (err) {
          await finishIngestRun(app.db, id, 'failed', {}, (err as Error).message);
        }
      })();
      return reply.code(202).send({ job_id: id, status_url: '/api/v1/admin/ingest/runs' });
    },
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    bills: BillsService;
  }
}
