import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { NOTE_TABLES, createTestApp, truncate, users, type TestContext } from './helpers.js';
import { DirectoryFetcher, ingestLegiscanBills, readDataset } from '../src/modules/bills/index.js';
import { seedTemplates } from '../src/modules/templates/index.js';
import { seedReference } from '../src/modules/reference/index.js';
import { seedUsers } from '../src/db/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGISCAN = join(here, 'fixtures', 'legiscan');
const XML_FIXTURES = join(here, '..', '..', '..', 'packages', 'bill-document', 'fixtures');

let t: TestContext;
/** Published note ids in publication order. */
const published: string[] = [];
let draftId: string;
let approvedId: string;

const drain = async () => {
  await t.app.bus.drain();
  await t.app.bus.drain();
};

async function createNote(billKey: string, versionCode: string): Promise<string> {
  const res = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey, versionCode, templateId: 'sales-use-tax-exemption', drafterId: 'dev-drafter' } });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().noteRevisionId as string;
}

async function send(id: string, u: (typeof users)[keyof typeof users], event: string): Promise<string> {
  const res = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${id}/workflow`, headers: await t.as(u), payload: { event } });
  if (res.statusCode !== 201) throw new Error(res.body);
  return res.json().state as string;
}

async function publish(billKey: string, versionCode: string): Promise<string> {
  const id = await createNote(billKey, versionCode);
  await send(id, users.drafter, 'SUBMIT');
  await send(id, users.reviewer, 'APPROVE');
  await send(id, users.reviewer, 'PUBLISH');
  await new Promise((r) => setTimeout(r, 5));
  return id;
}

beforeAll(async () => {
  t = await createTestApp({ SEARCH_BACKEND: 'postgres' });
  await truncate(t.handle, NOTE_TABLES);
  await seedUsers(t.app.db);
  await seedTemplates(t.app.db, t.config.TEMPLATES_DIR);
  await seedReference(t.app.db, t.config.REFERENCE_DIR);
  await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN, { bills: ['HB2402', 'SB6137'] }), {});
  await drain();
  published.push(await publish('WA:2025-26:HB2402', 'I'));
  published.push(await publish('WA:2025-26:SB6137', 'I'));
  published.push(await publish('WA:2025-26:HB2402', 'S'));
  draftId = await createNote('WA:2025-26:HB2402', 'S');
  approvedId = await createNote('WA:2025-26:SB6137', 'I');
  await send(approvedId, users.drafter, 'SUBMIT');
  await send(approvedId, users.reviewer, 'APPROVE');
  await drain();
});
afterAll(async () => {
  await t.close();
});

describe('GET /published', () => {
  it('lists published notes newest first with bill, version, publisher and the four export URLs', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/published', headers: await t.as(users.viewer) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((i: any) => i.revisionId)).toEqual([...published].reverse());
    const newest = body.items[0];
    expect(newest).toMatchObject({
      revisionId: published[2],
      bill: { biennium: '2025-26', billId: 'HB2402', number: '2402' },
      versionCode: 'S',
      versionLabel: 'SHB 2402',
      title: 'SHB 2402 Fiscal Note',
      publishedBy: { userId: 'dev-reviewer', displayName: 'Rae Reviewer' },
    });
    expect(newest.bill.title.length).toBeGreaterThan(0);
    expect(newest.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof newest.publishedVersion).toBe('number');
    const origin = t.config.PUBLIC_API_ORIGIN;
    expect(newest.exports).toEqual({
      pdf: `${origin}/api/v1/notes/${published[2]}/export?format=pdf`,
      docx: `${origin}/api/v1/notes/${published[2]}/export?format=docx`,
      html: `${origin}/api/v1/notes/${published[2]}/export?format=html`,
      xml: `${origin}/api/v1/notes/${published[2]}/export?format=xml`,
    });
    expect(body.items[2]).toMatchObject({ revisionId: published[0], versionCode: 'I', versionLabel: 'HB 2402', title: 'HB 2402 Fiscal Note' });
    expect(body.items[1]).toMatchObject({ bill: { billId: 'SB6137' }, versionLabel: 'SB 6137' });
    const at = body.items.map((i: any) => i.publishedAt as string);
    expect([...at].sort().reverse()).toEqual(at);
  });

  it('omits draft and approved notes', async () => {
    const ids = (await t.app.inject({ method: 'GET', url: '/api/v1/published', headers: await t.as(users.reviewer) })).json().items.map((i: any) => i.revisionId);
    expect(ids).not.toContain(draftId);
    expect(ids).not.toContain(approvedId);
    expect(ids).toHaveLength(3);
  });

  it('pages by limit and cursor', async () => {
    const first = (await t.app.inject({ method: 'GET', url: '/api/v1/published?limit=2', headers: await t.as(users.viewer) })).json();
    expect(first.items.map((i: any) => i.revisionId)).toEqual([published[2], published[1]]);
    expect(typeof first.nextCursor).toBe('string');
    const second = (await t.app.inject({ method: 'GET', url: `/api/v1/published?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, headers: await t.as(users.viewer) })).json();
    expect(second.items.map((i: any) => i.revisionId)).toEqual([published[0]]);
    expect(second.nextCursor).toBeNull();
    const exact = (await t.app.inject({ method: 'GET', url: '/api/v1/published?limit=3', headers: await t.as(users.viewer) })).json();
    expect(exact.items).toHaveLength(3);
    expect(exact.nextCursor).toBeNull();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/published?limit=201', headers: await t.as(users.viewer) })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/published?limit=0', headers: await t.as(users.viewer) })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/published?cursor=nope', headers: await t.as(users.viewer) })).statusCode).toBe(400);
  });

  it('is open to every signed-in role and to anonymous callers only with PUBLISHED_PUBLIC=true', async () => {
    for (const u of [users.drafter, users.reviewer, users.viewer, users.both]) {
      expect((await t.app.inject({ method: 'GET', url: '/api/v1/published', headers: await t.as(u) })).statusCode).toBe(200);
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/published' })).statusCode).toBe(401);
    const open = await createTestApp({ SEARCH_BACKEND: 'postgres', PUBLISHED_PUBLIC: 'true' });
    try {
      const res = await open.app.inject({ method: 'GET', url: '/api/v1/published' });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(3);
      const html = new URL(res.json().items[0].exports.html);
      expect((await open.app.inject({ method: 'GET', url: html.pathname + html.search })).statusCode).toBe(200);
    } finally {
      await open.close();
    }
  });

  it('the export URLs serve the published version to a viewer', async () => {
    const item = (await t.app.inject({ method: 'GET', url: '/api/v1/published?limit=1', headers: await t.as(users.viewer) })).json().items[0];
    const html = new URL(item.exports.html);
    const res = await t.app.inject({ method: 'GET', url: html.pathname + html.search, headers: await t.as(users.viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-document-version']).toBe(String(item.publishedVersion));
    expect(res.headers['content-disposition']).toBe('inline; filename="HB2402-S-fiscal-note.html"');
  });
});
