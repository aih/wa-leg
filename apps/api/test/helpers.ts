import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { loadConfig, type Config } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { signSession, type Principal, type OidcClient } from '../src/modules/identity/index.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wa_leg:wa_leg@localhost:5433/wa_leg_test';

export const users = {
  drafter: { userId: 'dev-drafter', displayName: 'Dana Drafter', email: 'dana@test', roles: ['drafter'], divisions: ['RFA'] },
  drafter2: { userId: 'dev-drafter2', displayName: 'Dev Drafter Two', email: 'd2@test', roles: ['drafter'], divisions: ['RFA'] },
  otherDivDrafter: { userId: 'dev-drafter3', displayName: 'Dev Drafter Three', email: 'd3@test', roles: ['drafter'], divisions: ['Audit'] },
  reviewer: { userId: 'dev-reviewer', displayName: 'Rae Reviewer', email: 'rae@test', roles: ['reviewer'], divisions: ['RFA'] },
  reviewer2: { userId: 'dev-reviewer2', displayName: 'Rae Reviewer Two', email: 'rae2@test', roles: ['reviewer'], divisions: ['RFA'] },
  approver: { userId: 'dev-approver', displayName: 'Avery Approver', email: 'avery@test', roles: ['reviewer', 'approver'], divisions: ['RFA'] },
  execBudget: { userId: 'dev-exec-budget', displayName: 'Blake Budget', email: 'blake@test', roles: ['reviewer', 'approver'], divisions: ['Budget'] },
  manager: { userId: 'dev-manager', displayName: 'Morgan Manager', email: 'morgan@test', roles: ['manager'], divisions: ['RFA'] },
  viewer: { userId: 'dev-viewer', displayName: 'Val Viewer', email: 'val@test', roles: ['viewer'], divisions: [] },
  templateEditor: { userId: 'dev-template-editor', displayName: 'Terry Templates', email: 'terry@test', roles: ['template_editor', 'drafter'], divisions: ['RFA'] },
  admin: { userId: 'dev-admin', displayName: 'Ada Admin', email: 'ada@test', roles: ['admin'], divisions: ['IT'] },
  both: { userId: 'dev-both', displayName: 'Jordan Both', email: 'jordan@test', roles: ['drafter', 'reviewer'], divisions: ['RFA'] },
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

/** Remove all rows from the given tables (children first). */
export async function truncate(handle: DbHandle, tables: string[]): Promise<void> {
  if (tables.length === 0) return;
  await handle.db.execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`));
}
