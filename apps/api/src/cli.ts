#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config.js';
import { ensureDatabase, migrate } from './db/migrate.js';
import { createDb } from './db/client.js';
import { seedUsers, seeders } from './db/seed.js';

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

export { program };

await program.parseAsync(process.argv);
