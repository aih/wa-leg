import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { createTestApp, truncate, users, type TestContext } from './helpers.js';
import { DirectoryFetcher, ingestLegiscanBills, readDataset } from '../src/modules/bills/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGISCAN = join(here, 'fixtures', 'legiscan');
const XML_FIXTURES = join(here, '..', '..', '..', 'packages', 'bill-document', 'fixtures');

let t: TestContext;

beforeAll(async () => {
  t = await createTestApp({ SEARCH_BACKEND: 'postgres' });
  await truncate(t.handle, ['bills', 'bill_versions', 'amendments', 'hearings', 'prior_fiscal_notes', 'outbox', 'outbox_consumptions', 'search_docs']);
  await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN), {});
  await t.app.searchSvc.backend.init();
  // Events from ingest drive the indexer.
  await t.app.bus.drain();
  await t.app.bus.drain();
  await t.app.searchSvc.backend.refresh();
});
afterAll(async () => {
  await t.close();
});

describe('search module (postgres backend)', () => {
  it('indexed bills, sections, amendments, OFM notes and RCW sections from bill events', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=&doc_type=bill&size=50', headers: await t.as(users.viewer) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.backend).toBe('postgres');
    expect(body.hits.map((h: any) => h.bill_key).sort()).toEqual(['WA:2025-26:HB1019', 'WA:2025-26:HB2402', 'WA:2025-26:SB5814', 'WA:2025-26:SB6137']);
    const facets = (await t.app.inject({ method: 'GET', url: '/api/v1/search?q=&size=1', headers: await t.as(users.viewer) })).json().facets;
    const types = Object.fromEntries(facets.doc_type.map((f: any) => [f.key, f.count]));
    expect(types.bill).toBe(4);
    expect(types.section).toBeGreaterThan(10);
    expect(types.amendment).toBeGreaterThanOrEqual(2);
    expect(types.fiscal_note).toBeGreaterThanOrEqual(2);
    expect(types.rcw_section).toBeGreaterThanOrEqual(1);
  });

  it('a bare reference resolves to a direct hit with related results', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=shb%202402', headers: await t.as(users.viewer) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.parsed).toMatchObject({ kind: 'bill', type: 'HB', number: 2402, versionCode: 'S', confidence: 'exact' });
    expect(body.direct).toMatchObject({ bill_key: 'WA:2025-26:HB2402', display: 'HB 2402', resolved_version_code: 'S', resolved_version_label: 'SHB 2402', url: '/bills/2025-26/HB2402/S', ambiguous: false });
    expect(body.direct.related.fiscal_notes.length).toBeGreaterThanOrEqual(2);
    expect(body.direct.related.rcw.some((r: any) => r.cite === '70A.350' || r.cite.startsWith('70A'))).toBe(true);
    expect(body.hits).toEqual([]);
  });

  it('a text query returns section hits with highlights and facets', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=phthalates', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.hits.some((h: any) => h.bill_key === 'WA:2025-26:HB2402')).toBe(true);
    const hb = body.hits.find((h: any) => h.bill_key === 'WA:2025-26:HB2402');
    expect(['bill', 'section']).toContain(hb.doc_type);
    // One hit per bill; the other matching documents ride along as inner hits.
    expect(body.hits.filter((h: any) => h.bill_key === 'WA:2025-26:HB2402').length).toBe(1);
    const withHighlight = body.hits.find((h: any) => h.highlight);
    expect(withHighlight).toBeTruthy();
    expect(JSON.stringify(withHighlight.highlight)).toContain('<mark>');
    expect(body.facets.doc_type.length).toBeGreaterThan(0);
    expect(body.facets.chamber.find((f: any) => f.key === 'H')).toBeTruthy();
  });

  it('a reference plus words filters the text search to the bill and keeps the direct hit', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=HB%202402%20intravenous', headers: await t.as(users.drafter) });
    const body = res.json();
    expect(body.parsed.remainder).toBe('INTRAVENOUS');
    expect(body.direct.bill_key).toBe('WA:2025-26:HB2402');
    expect(body.hits.every((h: any) => h.bill_key === 'WA:2025-26:HB2402')).toBe(true);
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it('an RCW reference filters by cite', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=RCW%209.46.038', headers: await t.as(users.viewer) });
    const body = res.json();
    expect(body.direct.kind).toBe('rcw');
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits.every((h: any) => h.bill_key === 'WA:2025-26:SB6137' || h.doc_type === 'rcw_section')).toBe(true);
  });

  it('filters and rejects client-supplied permission fields', async () => {
    const ok = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=&chamber=S&doc_type=bill', headers: await t.as(users.viewer) });
    expect(ok.json().hits.every((h: any) => h.bill_key.includes(':SB'))).toBe(true);
    const bad = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=tax&visibility=restricted', headers: await t.as(users.viewer) });
    expect(bad.statusCode).toBe(400);
  });

  it('suggest returns bill-number and title matches with the parsed reference first', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/search/suggest?q=24', headers: await t.as(users.viewer) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reference).toMatchObject({ kind: 'bill', number: 24 });
    expect(body.suggestions.some((s: any) => s.bill_key === 'WA:2025-26:HB2402')).toBe(true);
    const title = await t.app.inject({ method: 'GET', url: '/api/v1/search/suggest?q=sports', headers: await t.as(users.viewer) });
    expect(title.json().suggestions.some((s: any) => s.bill_key === 'WA:2025-26:SB6137')).toBe(true);
  });

  it('reindex is admin only', async () => {
    const denied = await t.app.inject({ method: 'POST', url: '/api/v1/search/reindex', headers: await t.as(users.reviewer), payload: { scope: 'bill', bill_keys: ['WA:2025-26:HB2402'] } });
    expect(denied.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/search/reindex', headers: await t.as(users.admin), payload: { scope: 'bill', bill_keys: ['WA:2025-26:HB2402'] } });
    expect(ok.statusCode).toBe(202);
  });
});
