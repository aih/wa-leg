import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { APP_VERSION, GIT_SHA } from '../../lib/version.js';

const HealthSchema = z.object({ ok: z.boolean(), version: z.string(), commit: z.string(), checks: z.record(z.string(), z.object({ ok: z.boolean(), detail: z.string().optional() })) });

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/health',
    {
      schema: {
        tags: ['health'],
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
}
