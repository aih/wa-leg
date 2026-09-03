import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { can } from '../identity/can.js';
import { forbidden } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { APP_VERSION, GIT_SHA } from '../../lib/version.js';

export const AuditRowSchema = z.object({
  id: z.number(),
  actorId: z.string(),
  action: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  requestId: z.string().nullable(),
  at: z.string(),
});

const HealthSchema = z.object({ ok: z.boolean(), version: z.string(), commit: z.string(), checks: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().optional() })) });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/health',
    {
      schema: {
        tags: ['admin'],
        summary: 'Liveness and dependency health',
        security: [],
        response: {
          200: HealthSchema,
          503: HealthSchema,
        },
      },
    },
    async (_req, reply) => {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};
      try {
        await app.db.execute(sql`SELECT 1`);
        checks.postgres = { ok: true };
      } catch (err) {
        checks.postgres = { ok: false, detail: (err as Error).message };
      }
      for (const [name, probe] of Object.entries(app.healthChecks)) {
        try {
          checks[name] = await probe();
        } catch (err) {
          checks[name] = { ok: false, detail: (err as Error).message };
        }
      }
      const ok = Object.values(checks).every((c) => c.ok);
      return reply.code(ok ? 200 : 503).send({ ok, version: APP_VERSION, commit: GIT_SHA, checks });
    },
  );

  r.get(
    '/admin/audit',
    {
      schema: {
        tags: ['admin'],
        summary: 'Audit log query',
        querystring: z.object({
          objectType: z.string().optional(),
          objectId: z.string().optional(),
          actor: z.string().optional(),
          action: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: z.array(AuditRowSchema) },
      },
      preHandler: app.requireAuth,
    },
    async (req) => {
      const p = req.principal!;
      const q = req.query;
      if (!can(p, 'audit.read_all')) {
        await writeAudit(app.db, {
          actorId: p.userId,
          action: 'permission.denied',
          objectType: 'audit',
          objectId: q.objectId ?? '*',
          requestId: req.id,
        });
        throw forbidden();
      }
      const conds = [sql`true`];
      if (q.objectType) conds.push(sql`object_type = ${q.objectType}`);
      if (q.objectId) conds.push(sql`object_id = ${q.objectId}`);
      if (q.actor) conds.push(sql`actor_id = ${q.actor}`);
      if (q.action) conds.push(sql`action = ${q.action}`);
      if (q.from) conds.push(sql`at >= ${q.from}::timestamptz`);
      if (q.to) conds.push(sql`at <= ${q.to}::timestamptz`);
      const res = await app.db.execute(
        sql`SELECT id, actor_id, action, object_type, object_id, before, after, request_id, at
            FROM audit_log WHERE ${sql.join(conds, sql` AND `)} ORDER BY at DESC, id DESC LIMIT ${q.limit}`,
      );
      return (res.rows as any[]).map((row) => ({
        id: Number(row.id),
        actorId: row.actor_id,
        action: row.action,
        objectType: row.object_type,
        objectId: row.object_id,
        before: row.before ?? null,
        after: row.after ?? null,
        requestId: row.request_id ?? null,
        at: new Date(row.at).toISOString(),
      }));
    },
  );
}
