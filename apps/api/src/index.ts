import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
if (config.NODE_ENV === 'development') {
  await migrate(config.DATABASE_URL, (m) => console.log(`[migrate] ${m}`));
}
const app = await buildApp({ config });
await app.listen({ port: config.API_PORT, host: config.API_HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
