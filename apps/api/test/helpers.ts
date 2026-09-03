import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { signSession, SYSTEM_PRINCIPAL, type Principal, type OidcClient } from '../src/modules/identity/index.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wa_leg:wa_leg@localhost:5433/wa_leg_test';

/** The four test users (apps/dev-oidc/users.json) and the system principal. */
export const users = {
  drafter: { userId: 'dev-drafter', displayName: 'Dana Drafter', email: 'dana.drafter@dor.wa.gov.test', roles: ['drafter'], divisions: ['RFA'] },
  reviewer: { userId: 'dev-reviewer', displayName: 'Rae Reviewer', email: 'rae.reviewer@dor.wa.gov.test', roles: ['reviewer'], divisions: ['RFA'] },
  viewer: { userId: 'dev-committee', displayName: 'Cam Committee', email: 'cam.committee@dor.wa.gov.test', roles: ['viewer'], divisions: [] },
  both: { userId: 'dev-both', displayName: 'Jordan Both', email: 'jordan.both@dor.wa.gov.test', roles: ['drafter', 'reviewer'], divisions: ['RFA'] },
  admin: SYSTEM_PRINCIPAL,
} satisfies Record<string, Principal>;

export function testConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DATABASE_URL, SEARCH_BACKEND: 'postgres', ...overrides });
}

export const fakeOidc: OidcClient = {
  async authorizationUrl() {
    return new URL('http://issuer.test/authorize');
  },
  async exchange() {
    return users.drafter;
  },
  async verifyBearer() {
    return null;
  },
  async endSessionUrl() {
    return null;
  },
};

export interface TestContext {
  app: FastifyInstance;
  handle: DbHandle;
  config: Config;
  as(p: Principal): Promise<{ authorization: string }>;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Partial<Record<keyof Config, string>> = {}): Promise<TestContext> {
  const config = testConfig(overrides);
  const handle = createDb(config.DATABASE_URL, 5);
  const app = await buildApp({ config, dbHandle: handle, oidc: fakeOidc, workers: false });
  await app.ready();
  const tokens = new Map<string, string>();
  return {
    app,
    handle,
    config,
    async as(p) {
      let t = tokens.get(p.userId);
      if (!t) {
        t = await signSession(p, config.SESSION_SECRET, 3600);
        tokens.set(p.userId, t);
      }
      return { authorization: `Bearer ${t}` };
    },
    async close() {
      await app.close();
      await handle.close();
    },
  };
}

/** Tables the note tests reset between files (children first). */
export const NOTE_TABLES = ['bills', 'bill_versions', 'amendments', 'hearings', 'prior_fiscal_notes', 'outbox', 'outbox_consumptions', 'search_docs', 'notes', 'note_revisions', 'note_documents', 'note_comments', 'note_comment_messages', 'note_change_requests', 'note_exports', 'templates', 'reference_sets', 'audit_log', 'workflow_instances', 'workflow_transitions'];

/** Remove all rows from the given tables (children first). */
export async function truncate(handle: DbHandle, tables: string[]): Promise<void> {
  if (tables.length === 0) return;
  await handle.db.execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`));
}
