#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { ensureDatabase, migrate } from './db/migrate.js';
import { createDb } from './db/client.js';
import { seedUsers, seeders } from './db/seed.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pino from 'pino';
import { CachingFetcher, finishIngestRun, ingestLegiscanBills, readDataset, recordIngestRun, refreshDocuments } from './modules/bills/index.js';

const program = new Command();
program.name('wa-leg').description('Fiscal Note Workbench command line');

const db = program.command('db').description('Database maintenance');
db.command('migrate')
  .description('Create the database if needed and apply pending SQL migrations')
  .action(async () => {
    const cfg = loadConfig();
    await ensureDatabase(cfg.DATABASE_URL);
    const res = await migrate(cfg.DATABASE_URL, (m) => console.log(m));
    console.log(`applied ${res.applied.length}, already applied ${res.skipped.length}`);
  });
db.command('seed')
  .description('Seed development users, templates, and reference data')
  .action(async () => {
    const cfg = loadConfig();
    const handle = createDb(cfg.DATABASE_URL);
    try {
      const n = await seedUsers(handle.db);
      console.log(`users: ${n}`);
      for (const s of seeders) console.log(`${s.name}: ${await s.run(handle.db)}`);
    } finally {
      await handle.close();
    }
  });

const ingest = program.command('ingest').description('Load and refresh bill data');
ingest
  .command('legiscan <dir>')
  .description('Load a Legiscan dataset directory (WA/2025-2026_Regular_Session) and fetch bill text from lawfilesext')
  .option('--limit <n>', 'Only the first n bill files', (v) => Number(v))
  .option('--bills <list>', 'Comma-separated bill numbers (HB2402,SB6137)')
  .option('--no-fetch', 'Index only; do not fetch documents')
  .option('--concurrency <n>', 'Parallel bills', (v) => Number(v), 4)
  .option('--force', 'Reload bills whose change_hash is unchanged')
  .action(async (dir: string, o: { limit?: number; bills?: string; fetch: boolean; concurrency: number; force?: boolean }) => {
    const cfg = loadConfig();
    const handle = createDb(cfg.DATABASE_URL);
    const log = pino({ level: cfg.LOG_LEVEL });
    const id = randomUUID();
    try {
      const billsJson = readDataset(resolve(process.env.INIT_CWD ?? process.cwd(), dir), { limit: o.limit, bills: o.bills?.split(',').map((b) => b.trim()) });
      console.log(`loading ${billsJson.length} bills from ${dir}`);
      await recordIngestRun(handle.db, { id, source: 'legiscan', path: dir, requestedBy: 'cli' });
      const stats = await ingestLegiscanBills(
        { db: handle.db, fetcher: new CachingFetcher(cfg.LAWFILES_CACHE_DIR), log },
        billsJson,
        { fetchDocuments: o.fetch, concurrency: o.concurrency, force: o.force, onProgress: (m) => process.stdout.write(m + '\n') },
      );
      await finishIngestRun(handle.db, id, 'done', stats);
      console.log(JSON.stringify({ ...stats, errors: stats.errors.slice(0, 20) }, null, 2));
    } catch (err) {
      await finishIngestRun(handle.db, id, 'failed', {}, (err as Error).message);
      throw err;
    } finally {
      await handle.close();
    }
  });
ingest
  .command('refresh')
  .description('Re-check stored documents against lawfilesext (ETag / Last-Modified) and reparse changed ones')
  .option('--bills <list>', 'Comma-separated bill keys or numbers')
  .action(async (o: { bills?: string }) => {
    const cfg = loadConfig();
    const handle = createDb(cfg.DATABASE_URL);
    const log = pino({ level: cfg.LOG_LEVEL });
    const id = randomUUID();
    try {
      await recordIngestRun(handle.db, { id, source: 'refresh', requestedBy: 'cli' });
      const keys = o.bills?.split(',').map((b) => (b.includes(':') ? b : `WA:${cfg.CURRENT_BIENNIUM}:${b.trim().toUpperCase()}`));
      const stats = await refreshDocuments({ db: handle.db, fetcher: new CachingFetcher(cfg.LAWFILES_CACHE_DIR), log }, { billKeys: keys, onProgress: (m) => process.stdout.write(m + '\n') });
      await finishIngestRun(handle.db, id, 'done', stats);
      console.log(JSON.stringify(stats, null, 2));
    } finally {
      await handle.close();
    }
  });

const search = program.command('search').description('Search index maintenance');
search
  .command('init')
  .description('Create the search indices and aliases (OpenSearch) or verify the fallback table')
  .action(async () => {
    const { buildApp } = await import('./app.js');
    const cfg = loadConfig();
    const app = await buildApp({ config: cfg, workers: false });
    await app.ready();
    try {
      await app.searchSvc.backend.init();
      console.log(`search backend ${app.searchSvc.backend.name} ready`);
    } finally {
      await app.close();
    }
  });
search
  .command('load')
  .description('Index every bill of the biennium from the bills API')
  .option('--biennium <b>', 'Biennium', undefined)
  .option('--limit <n>', 'Only the first n bills', (v) => Number(v))
  .option('--bills <list>', 'Comma-separated bill keys or numbers')
  .action(async (o: { biennium?: string; limit?: number; bills?: string }) => {
    const { buildApp } = await import('./app.js');
    const cfg = loadConfig();
    const app = await buildApp({ config: cfg, workers: false });
    await app.ready();
    try {
      await app.searchSvc.backend.init();
      const biennium = o.biennium ?? cfg.CURRENT_BIENNIUM;
      if (o.bills) {
        let docs = 0;
        for (const b of o.bills.split(',')) {
          const key = b.includes(':') ? b : `WA:${biennium}:${b.trim().toUpperCase()}`;
          docs += await app.searchSvc.indexer.indexBill(key);
          console.log(`${key} indexed`);
        }
        await app.searchSvc.backend.refresh();
        console.log(`${docs} documents`);
      } else {
        const res = await app.searchSvc.indexer.loadAll({ biennium, limit: o.limit, onProgress: (m: string) => console.log(m) });
        console.log(JSON.stringify({ ...res, errors: res.errors.slice(0, 20) }, null, 2));
      }
    } finally {
      await app.close();
    }
  });

export { program };

await program.parseAsync(process.argv);
