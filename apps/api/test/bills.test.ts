import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { diffVersions, parseBillXml, type BillDocument, type VersionDiff } from '@wa-leg/bill-document';
import { createTestApp, truncate, users, type TestContext } from './helpers.js';
import { DirectoryFetcher, ingestLegiscanBills, readDataset } from '../src/modules/bills/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGISCAN = join(here, 'fixtures', 'legiscan');
const XML_FIXTURES = join(here, '..', '..', '..', 'packages', 'bill-document', 'fixtures');

let t: TestContext;

beforeAll(async () => {
  t = await createTestApp();
  await truncate(t.handle, ['bills', 'bill_versions', 'amendments', 'hearings', 'prior_fiscal_notes', 'ingest_runs', 'outbox', 'outbox_consumptions', 'audit_log']);
  const stats = await ingestLegiscanBills(
    { db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger },
    readDataset(LEGISCAN),
    { concurrency: 2 },
  );
  expect(stats.billsSeen).toBe(3);
  expect(stats.errors).toEqual([]);
});
afterAll(async () => {
  await t.close();
});

describe('bills module', () => {
  it('loads bills, versions, hearings, amendments and prior fiscal notes from the Legiscan index', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402', headers: await t.as(users.viewer) });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.billKey).toBe('WA:2025-26:HB2402');
    expect(b.title).toMatch(/phthalates/i);
    expect(b.versions.map((v: any) => v.code)).toEqual(['I', 'S']);
    expect(b.versions[1].shortLabel).toBe('SHB 2402');
    expect(b.versions[1].status).toBe('parsed');
    expect(b.currentVersionCode).toBe('S');
    expect(b.hearings.length).toBeGreaterThanOrEqual(3);
    expect(b.hearings[0]).toMatchObject({ committee: 'Health Care & Wellness', chamber: 'H', kind: 'public_hearing' });
    // 2026-01-23 08:00 Pacific is 16:00 UTC
    expect(b.hearings[0].hearingAt).toBe('2026-01-23T16:00:00.000Z');
    expect(b.priorFiscalNotes.map((p: any) => p.label)).toEqual(expect.arrayContaining(['2402 HB (Final)', '2402 HB (Revised)']));
    expect(b.priorFiscalNotes[0].versionLabel).toBe('HB 2402');
    expect(b.priorFiscalNotes[0].url).toContain('packageID=');
    expect(b.rcwAffected.length).toBeGreaterThan(0);
  });

  it('GET /bills/2025-26/HB2402/versions/S returns a Bill Document', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/versions/S', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    const doc = res.json() as BillDocument & { resolvedCode: string };
    expect(doc.schemaVersion).toBe('1.0');
    expect(doc.bill.id).toBe('HB2402');
    expect(doc.version.code).toBe('S');
    expect(doc.version.label).toBe('Substitute House Bill');
    expect(doc.version.isCurrent).toBe(true);
    expect(doc.versions?.map((v) => v.code)).toEqual(['I', 'S']);
    expect(doc.sections.length).toBe(5);
    expect(doc.sections[3]).toMatchObject({ id: 'sec-4', sourceKind: 'addchap', identity: 'newchap:70A:1' });
    expect(doc.resolvedCode).toBe('S');
    // Matches a direct parse of the fixture.
    const direct = parseBillXml(readFileSync(join(XML_FIXTURES, '2402-S.xml'), 'utf8'), { biennium: '2025-26', type: 'HB', number: 2402, versionCode: 'S' });
    expect(doc.sections.map((s) => s.textHash)).toEqual(direct.sections.map((s) => s.textHash));
  });

  it('code=current resolves to the newest version without a redirect', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/versions/current', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolvedCode).toBe('S');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('returns one section', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/SB6137/versions/I/sections/sec-2', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'sec-2', identity: 'rcw:9.46.038', kind: 'amendatory' });
  });

  it('GET .../diff?from=I&to=S returns a VersionDiff that equals the client-side diff', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/diff?from=I&to=S', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    const d = res.json() as VersionDiff;
    expect(d.from).toBe('I');
    expect(d.to).toBe('S');
    expect(d.mode).toBe('as-printed');
    expect(d.sections.length).toBe(5);
    expect(d.summary.sectionsChanged).toBeGreaterThan(0);
    const i = (await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/versions/I', headers: await t.as(users.drafter) })).json();
    const s = (await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/versions/S', headers: await t.as(users.drafter) })).json();
    const client = diffVersions(i, s, 'as-printed');
    expect(d).toEqual(JSON.parse(JSON.stringify(client)));
  });

  it('diffs a striking amendment as a version', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/SB6137/diff?from=I&to=amend:6137_AMH_SGOV_H3681.1', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    const d = res.json() as VersionDiff;
    expect(d.to).toBe('amend:6137 AMH SGOV H3681.1');
    expect(d.sections.some((s) => s.status === 'added' || s.status === 'changed')).toBe(true);
  });

  it('lists and returns amendments (spaces may be sent as underscores)', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/SB6137/amendments', headers: await t.as(users.viewer) });
    expect(list.statusCode).toBe(200);
    const rows = list.json();
    expect(rows.map((a: any) => a.amendmentId)).toEqual(expect.arrayContaining(['6137 AMS CORA S4812.1', '6137 AMH SGOV H3681.1']));
    const striker = rows.find((a: any) => a.amendmentId === '6137 AMH SGOV H3681.1');
    expect(striker).toMatchObject({ kind: 'striking', scope: 'committee', adopted: true, baseVersionCode: 'I' });
    const one = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/SB6137/amendments/6137_AMS_CORA_S4812.1', headers: await t.as(users.viewer) });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ kind: 'page-line', status: 'withdrawn', floorNumber: '579' });
  });

  it('lists hearings', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/hearings', headers: await t.as(users.viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(3);
  });

  it('resolves references', async () => {
    const ok = await t.app.inject({ method: 'GET', url: '/api/v1/bills/resolve?ref=shb%202402', headers: await t.as(users.viewer) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().resolved).toMatchObject({ bill_key: 'WA:2025-26:HB2402', version_code: 'S', version_label: 'SHB 2402', url: '/bills/2025-26/HB2402/S' });
    const latest = await t.app.inject({ method: 'GET', url: '/api/v1/bills/resolve?ref=HB%202402', headers: await t.as(users.viewer) });
    expect(latest.json().resolved.version_code).toBe('S');
    const missing = await t.app.inject({ method: 'GET', url: '/api/v1/bills/resolve?ref=HB%201234', headers: await t.as(users.viewer) });
    expect(missing.statusCode).toBe(404);
    const bad = await t.app.inject({ method: 'GET', url: '/api/v1/bills/resolve?ref=phthalates', headers: await t.as(users.viewer) });
    expect(bad.statusCode).toBe(400);
    const amd = await t.app.inject({ method: 'GET', url: '/api/v1/bills/resolve?ref=S4812.1', headers: await t.as(users.viewer) });
    expect(amd.json().resolved.amendmentId).toBe('6137 AMS CORA S4812.1');
    const rcw = await t.app.inject({ method: 'GET', url: '/api/v1/bills/resolve?ref=RCW%2082.04.260', headers: await t.as(users.viewer) });
    expect(rcw.json().external).toContain('cite=82.04.260');
  });

  it('is idempotent: reloading unchanged bills does not duplicate rows or events', async () => {
    const before = Number(((await t.app.db.execute(sql`SELECT count(*) AS n FROM outbox`)).rows[0] as any).n);
    const stats = await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN), {});
    expect(stats.billsUnchanged).toBe(3);
    expect(stats.billsUpserted).toBe(0);
    const after = Number(((await t.app.db.execute(sql`SELECT count(*) AS n FROM outbox`)).rows[0] as any).n);
    expect(after).toBe(before);
    const versions = await t.app.db.execute(sql`SELECT count(*) AS n FROM bill_versions WHERE bill_key = 'WA:2025-26:HB2402'`);
    expect(Number((versions.rows[0] as any).n)).toBe(2);
  });

  it('emitted bill.created, bill.version_added, hearing.scheduled and bill.amendment_added events', async () => {
    const rows = (await t.app.db.execute(sql`SELECT type, count(*) AS n FROM outbox GROUP BY type ORDER BY type`)).rows as { type: string; n: string }[];
    const counts = Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
    expect(counts['bill.created']).toBe(3);
    expect(counts['bill.version_added']).toBeGreaterThanOrEqual(4);
    expect(counts['hearing.scheduled']).toBeGreaterThanOrEqual(3);
    expect(counts['bill.amendment_added']).toBeGreaterThanOrEqual(2);
  });

  it('records ingest runs and refuses ingest to non-admins', async () => {
    const denied = await t.app.inject({ method: 'POST', url: '/api/v1/admin/ingest/runs', headers: await t.as(users.drafter), payload: { source: 'refresh' } });
    expect(denied.statusCode).toBe(403);
    const runs = await t.app.inject({ method: 'GET', url: '/api/v1/admin/ingest/runs', headers: await t.as(users.admin) });
    expect(runs.statusCode).toBe(200);
  });

  it('marks a version missing when neither XML nor HTM exists', async () => {
    const row = (await t.app.db.execute(sql`SELECT status FROM bill_versions WHERE bill_key = 'WA:2025-26:SB5814' AND version_code = 'PL'`)).rows[0] as any;
    // 5814-S.PL is not in the fixture directory
    const missing = (await t.app.db.execute(sql`SELECT version_code, status FROM bill_versions WHERE bill_key = 'WA:2025-26:SB5814' ORDER BY seq`)).rows as any[];
    expect(missing.some((m) => m.status === 'missing')).toBe(true);
    expect(missing.find((m) => m.version_code === 'S')?.status).toBe('parsed');
    void row;
  });
});
