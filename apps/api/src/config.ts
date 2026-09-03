import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, '..', '..', '..');

/** Load KEY=value lines from the repo-root .env into process.env without overriding existing values. */
export function loadDotEnv(file = join(REPO_ROOT, '.env')): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const bool = z
  .string()
  .optional()
  .transform((v) => v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().default('postgres://wa_leg:wa_leg@localhost:5433/wa_leg'),
  API_PORT: z.coerce.number().int().default(4800),
  API_HOST: z.string().default('0.0.0.0'),
  PUBLIC_API_ORIGIN: z.string().default('http://localhost:4800'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(16).default('dev-session-secret-change-me'),
  SESSION_TTL_SECONDS: z.coerce.number().int().default(8 * 3600),
  SESSION_COOKIE_SECURE: bool.default(false),
  OIDC_ISSUER: z.string().default('http://localhost:4801'),
  OIDC_CLIENT_ID: z.string().default('wa-leg-web'),
  OIDC_CLIENT_SECRET: z.string().default('dev-client-secret'),
  OIDC_REDIRECT_URI: z.string().default('http://localhost:4800/api/v1/auth/callback'),
  OIDC_SCOPES: z.string().default('openid profile email roles'),
  OIDC_ROLE_CLAIM: z.string().default('roles'),
  /** JSON object mapping IdP group or role claim values to application roles. Empty means identity mapping. */
  OIDC_ROLE_MAP: z.string().default('{}'),
  OIDC_DIVISION_CLAIM: z.string().default('divisions'),
  SEARCH_BACKEND: z.enum(['opensearch', 'postgres']).default('opensearch'),
  OPENSEARCH_URL: z.string().default('http://localhost:9201'),
  OPENSEARCH_INDEX_PREFIX: z.string().default('waleg_'),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  MAIL_FROM: z.string().default('fiscal-notes@dor.wa.gov.test'),
  NOTIFY_EMAIL: bool.default(true),
  EXPORT_DIR: z.string().default('.cache/exports').transform((p) => (isAbsolute(p) ? p : join(REPO_ROOT, p))),
  PDF_ENABLED: bool.default(true),
  /** Anonymous access to GET /published and the published exports. */
  PUBLISHED_PUBLIC: bool.default(false),
  LAWFILES_CACHE_DIR: z.string().default('.cache/lawfiles').transform((p) => (isAbsolute(p) ? p : join(REPO_ROOT, p))),
  LEGISCAN_DIR: z.string().default('data/WA/2025-2026_Regular_Session').transform((p) => (isAbsolute(p) ? p : join(REPO_ROOT, p))),
  CURRENT_BIENNIUM: z.string().default('2025-26'),
  TEMPLATES_DIR: z.string().default(join(REPO_ROOT, 'design', 'templates')),
  REFERENCE_DIR: z.string().default(join(REPO_ROOT, 'reference')),
  /** Same-division drafters may read each other's drafts (personas-dashboards.md, "configurable"). */
  DIVISION_READ: bool.default(true),
  /** Reviewer may edit the document while the review is active. */
  REVIEWER_EDIT: bool.default(true),
  /** Open item: where the 72-hour clock starts. `request` = requestedAt from the request record. */
  STATUTORY_CLOCK_START: z.enum(['request']).default('request'),
  STATUTORY_HOURS: z.coerce.number().default(72),
  HEARING_LEAD_HOURS: z.coerce.number().default(4),
  OUTBOX_POLL_MS: z.coerce.number().int().default(500),
  DEADLINE_POLL_MS: z.coerce.number().int().default(60_000),
  AUTO_REVISION_ON_NEW_VERSION: bool.default(false),
});

export type Config = z.infer<typeof ConfigSchema> & { roleMap: Record<string, string> };

export function loadConfig(overrides: Partial<Record<keyof z.infer<typeof ConfigSchema>, string>> = {}): Config {
  loadDotEnv();
  const parsed = ConfigSchema.parse({ ...process.env, ...overrides });
  let roleMap: Record<string, string> = {};
  try {
    roleMap = JSON.parse(parsed.OIDC_ROLE_MAP);
  } catch {
    throw new Error('OIDC_ROLE_MAP must be a JSON object');
  }
  return { ...parsed, roleMap };
}
