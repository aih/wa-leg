// Reference data sets (fiscal years, accounts, revenue sources, job classes, phrases, WAC titles) from reference/*.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sessionLabels, type TemplateContext } from '@wa-leg/note-schema';
import type { Db, DbOrTx } from '../../db/client.js';
import { notFound } from '../../lib/errors.js';
import type { Principal } from '../identity/index.js';

export const REFERENCE_SETS = ['fiscal-years', 'accounts', 'revenue-sources', 'job-classes', 'phrases', 'wac-458'] as const;

export async function seedReference(db: DbOrTx, dir: string, session = '2025-26'): Promise<number> {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const name = f.replace(/\.json$/, '');
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    await db.execute(sql`INSERT INTO reference_sets (name, session, data, updated_at) VALUES (${name}, ${session}, ${JSON.stringify(data)}::jsonb, now())
      ON CONFLICT (name, session) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`);
    n++;
  }
  return n;
}

export class ReferenceService {
  constructor(
    private readonly db: Db,
    private readonly session: string,
  ) {}

  async get(name: string, session = this.session): Promise<Record<string, unknown>> {
    const r = (await this.db.execute(sql`SELECT data FROM reference_sets WHERE name = ${name} AND session = ${session}`)).rows[0] as { data: Record<string, unknown> } | undefined;
    if (!r) throw notFound(`Reference set ${name}`);
    return r.data;
  }

  /** The per-session part of a TemplateContext: labels, reference figures, salaries, agency constants. */
  async baseContext(principal?: Principal | null): Promise<TemplateContext> {
    const fy = (await this.get('fiscal-years')) as any;
    const jobs = (await this.get('job-classes')) as { classes: { key: string; title: string; salary: number }[] };
    const labels = sessionLabels(Number(fy.sessionYear ?? 2026));
    const salary: Record<string, string> = {};
    for (const j of jobs.classes) salary[j.key] = j.salary.toLocaleString('en-US');
    const today = new Date();
    const mdY = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
    return {
      bill: { number: '', numberOnly: '', version: '', title: '' },
      agency: { code: '140', name: 'Department of Revenue' },
      request: { date: mdY, tenYearRequested: false },
      legContact: { name: '', phone: '' },
      preparer: { name: principal?.displayName ?? '', phone: '', date: mdY, datetime: `${mdY} ${today.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` },
      approver: { name: '', phone: '', date: '' },
      ofm: { name: '', phone: '', date: '' },
      session: { year: Number(fy.sessionYear ?? 2026), biennium: String(fy.session ?? this.session) },
      fy: labels.fy,
      bien: labels.bien,
      cy: labels.cy,
      impl: { date: '', leadMonths: 0 },
      impact: { months: { state: '', local: '' } },
      ref: {
        forecast: { vintage: String(fy.forecastVintage ?? '') },
        localRate: String(fy.localRate ?? '3.0'),
        aprilShare: String(fy.aprilShare ?? '52.62'),
        octoberShare: String(fy.octoberShare ?? '47.38'),
        performanceAuditsShare: String(fy.performanceAuditsShare ?? '0.16'),
        salary,
        tes: { year: Number(fy.tesYear ?? 2024) },
        priorYear: Number(fy.priorYear ?? labels.fy[0]!.year - 1),
        priorFY: String(fy.priorFY ?? `FY ${labels.fy[0]!.year - 1}`),
        cpi: fy.cpi ?? {},
        threshold1Pct: String(fy.threshold1Pct ?? ''),
        thresholdStep: String(fy.thresholdStep ?? ''),
        thresholdDate: String(fy.thresholdDate ?? ''),
        passDate: String(fy.passDate ?? ''),
      } as TemplateContext['ref'],
      revision: { scope: '' },
      prior: {},
    };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    reference: ReferenceService;
  }
}

export async function referenceRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/reference/template-context',
    { schema: { tags: ['reference'], summary: 'Base template token context for the session', response: { 200: z.looseObject({}) } }, preHandler: app.requireAuth },
    async (req) => (await app.reference.baseContext(req.principal)) as unknown as Record<string, unknown>,
  );
  r.get(
    '/reference/:set',
    { schema: { tags: ['reference'], summary: 'Reference data set (fiscal-years, accounts, revenue-sources, job-classes, phrases, wac-458)', params: z.object({ set: z.string() }), querystring: z.object({ session: z.string().optional() }), response: { 200: z.looseObject({}) } }, preHandler: app.requireAuth },
    async (req, reply) => {
      reply.header('cache-control', 'private, max-age=300');
      return app.reference.get(req.params.set, req.query.session);
    },
  );
}
