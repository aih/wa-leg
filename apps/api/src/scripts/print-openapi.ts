import { loadConfig } from '../config.js';
import { buildApp } from '../app.js';

const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test' }), workers: false });
await app.ready();
const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
process.stdout.write(JSON.stringify(res.json(), null, 2) + '\n');
await app.close();
