#!/usr/bin/env node
// Load test with autocannon against a running API (ARCHITECTURE.md "Non-functional targets"):
// 60 simultaneous users with a 3x burst; P95 under 500 ms for reads and 1 s for saves.
//
// Model: a signed-in user issues about one request every three seconds (20 req/s for 60 users); the burst is
// three times that, 60 req/s, spread over 180 connections. Each read scenario runs at that rate for DURATION s.
//
//   pnpm load                      # defaults: API http://localhost:4800, 60 req/s over 180 connections, 20 s
//   API_ORIGIN=... RATE=120 CONNECTIONS=180 DURATION=10 pnpm load
//
// The script mints bearer tokens with `wa-leg token` and exercises the read paths a session hits most: the bill
// document, search, the note summary and the drafter queue; then autosave at one third of the connections.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import autocannon from 'autocannon';

const API = process.env.API_ORIGIN ?? 'http://localhost:4800';
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 180);
const RATE = Number(process.env.RATE ?? 60);
const DURATION = Number(process.env.DURATION ?? 20);
const OUT = process.env.LOAD_OUT ?? 'docs/LOAD-TEST.md';

function token(user) {
  return execFileSync('pnpm', ['--filter', '@wa-leg/api', '--silent', 'run', 'cli', 'token', '--user', user], { encoding: 'utf8' }).trim().split('\n').pop();
}

async function json(path, tok) {
  const res = await fetch(`${API}/api/v1${path}`, { headers: { authorization: `Bearer ${tok}` } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function run(title, opts) {
  const result = await autocannon({ url: API, connections: CONNECTIONS, duration: DURATION, pipelining: 1, overallRate: opts.connections === 1 ? undefined : RATE, ...opts });
  const row = { title, requests: result.requests.total, rps: Math.round(result.requests.average), p50: result.latency.p50, p95: result.latency.p97_5 ? result.latency.p97_5 : result.latency.p99, p99: result.latency.p99, errors: result.errors + result.non2xx, connections: opts.connections ?? CONNECTIONS };
  // autocannon reports p2_5/p50/p97_5/p99; P95 is read from the percentile table when present.
  row.p95 = result.latency.p95 ?? row.p95;
  console.log(`${title}: ${row.rps} req/s, p50 ${row.p50} ms, p95 ${row.p95} ms, p99 ${row.p99} ms, errors ${row.errors}`);
  return row;
}

const viewer = token('dev-committee');
const drafter = token('dev-drafter');
const reviewer = token('dev-reviewer');
const auth = (t) => ({ authorization: `Bearer ${t}` });

// A note the drafter can autosave.
const created = await (await fetch(`${API}/api/v1/notes`, { method: 'POST', headers: { ...auth(reviewer), 'content-type': 'application/json' }, body: JSON.stringify({ billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter' }) })).json();
const noteId = created.noteRevisionId;
const head = await json(`/notes/${noteId}/document`, drafter);

const rows = [];
rows.push(await run('GET bill document (SHB 2402)', { requests: [{ path: '/api/v1/bills/2025-26/HB2402/versions/S', headers: auth(viewer) }] }));
// Eight rotating queries so the ten-second per-caller result cache is not what is measured.
const QUERIES = ['phthalates', 'sales tax exemption', 'property tax', 'retail sales', 'estate tax', 'business and occupation', 'medical equipment', 'wagering'];
rows.push(await run('GET search (8 rotating queries)', { requests: QUERIES.map((q) => ({ path: `/api/v1/search?q=${encodeURIComponent(q)}`, headers: auth(viewer) })) }));
rows.push(await run('GET search suggest (sales)', { requests: [{ path: '/api/v1/search/suggest?q=sales', headers: auth(viewer) }] }));
rows.push(await run('GET note summary + workflow', { requests: [{ path: `/api/v1/notes/${noteId}`, headers: auth(drafter) }] }));
rows.push(await run('GET notes list', { requests: [{ path: '/api/v1/notes', headers: auth(drafter) }] }));
// Autosave: each request carries If-Match with the current version; concurrent saves of the same note conflict
// by design, so the save path runs on one connection at a time per note to measure the write cost.
let version = head.version;
rows.push(
  await run('PUT autosave (1 connection)', {
    connections: 1,
    duration: Math.min(DURATION, 10),
    requests: [
      {
        method: 'PUT',
        path: `/api/v1/notes/${noteId}/document`,
        headers: { ...auth(drafter), 'content-type': 'application/json', 'if-match': `"${version}"` },
        body: JSON.stringify({ doc: head.doc, mode: head.mode, clientId: 'load' }),
        onResponse: (status, body) => {
          try {
            version = JSON.parse(body).version ?? version;
          } catch {
            /* keep */
          }
        },
      },
    ],
  }),
);

const targets = { read: 500, save: 1000 };
const lines = [
  '# Load test',
  '',
  `Run on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC against ${API} with autocannon: ${RATE} requests/s (60 users × 3 burst at one request every 3 s) over ${CONNECTIONS} connections, ${DURATION} s per read scenario; autosave on one connection at full speed.`,
  'Targets (ARCHITECTURE.md): P95 under 500 ms for reads and under 1 s for saves.',
  '',
  '| Scenario | Connections | Requests | Req/s achieved | P50 ms | P95 ms | P99 ms | Errors | Target met |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.title} | ${r.connections} | ${r.requests} | ${r.rps} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.errors} | ${r.p95 <= (r.title.startsWith('PUT') ? targets.save : targets.read) && r.errors === 0 ? 'yes' : 'no'} |`),
  '',
  'Run with `pnpm load` while `pnpm dev` (or the API alone) is up and the Legiscan dataset is loaded. `CONNECTIONS` and `DURATION` override the defaults.',
  '',
];
writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT}`);
const failed = rows.filter((r) => r.errors > 0 || r.p95 > (r.title.startsWith('PUT') ? targets.save : targets.read));
process.exit(failed.length ? 1 : 0);
