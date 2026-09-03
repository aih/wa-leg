import { ensureDatabase, migrate } from '../src/db/migrate.js';
import { loadDotEnv } from '../src/config.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wa_leg:wa_leg@localhost:5433/wa_leg_test';

export default async function setup(): Promise<void> {
  loadDotEnv();
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  await ensureDatabase(TEST_DATABASE_URL);
  await migrate(TEST_DATABASE_URL);
}
