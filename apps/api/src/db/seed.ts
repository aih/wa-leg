import { sql } from 'drizzle-orm';
import { createRequire } from 'node:module';
import type { Db } from './client.js';
import { pgTextArray } from '../lib/sql.js';

const require = createRequire(import.meta.url);

interface DevUser {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  divisions: string[];
}

/** Seed development users from the dev issuer's user list so names resolve before first login. */
export async function seedUsers(db: Db): Promise<number> {
  const users = require('@wa-leg/dev-oidc/users.json') as DevUser[];
  for (const u of users) {
    await db.execute(sql`INSERT INTO users (user_id, subject, display_name, email, roles, divisions)
      VALUES (${u.sub}, ${u.sub}, ${u.name}, ${u.email}, ${pgTextArray(u.roles)}::text[], ${pgTextArray(u.divisions)}::text[])
      ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email,
        roles = EXCLUDED.roles, divisions = EXCLUDED.divisions`);
  }
  return users.length;
}

import { seedTemplates } from '../modules/templates/service.js';
import { seedReference } from '../modules/reference/index.js';
import { loadConfig } from '../config.js';

/** Seed steps: templates from design/templates, reference sets from reference/. */
export const seeders: Array<{ name: string; run: (db: Db) => Promise<string> }> = [
  { name: 'templates', run: async (db) => `${await seedTemplates(db, loadConfig().TEMPLATES_DIR)} new version(s)` },
  { name: 'reference', run: async (db) => `${await seedReference(db, loadConfig().REFERENCE_DIR)} set(s)` },
];
