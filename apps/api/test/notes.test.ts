import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { findAll, textOf, type PMNode } from '@wa-leg/note-schema';
import { NOTE_TABLES, createTestApp, truncate, users, type TestContext } from './helpers.js';
import { DirectoryFetcher, ingestLegiscanBills, readDataset } from '../src/modules/bills/index.js';
import { seedTemplates } from '../src/modules/templates/index.js';
import { seedReference } from '../src/modules/reference/index.js';
import { seedUsers } from '../src/db/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGISCAN = join(here, 'fixtures', 'legiscan');
const XML_FIXTURES = join(here, '..', '..', '..', 'packages', 'bill-document', 'fixtures');

let t: TestContext;
let revisionId: string;

beforeAll(async () => {
  t = await createTestApp({ SEARCH_BACKEND: 'postgres' });
  await truncate(t.handle, NOTE_TABLES);
  await seedUsers(t.app.db);
  await seedTemplates(t.app.db, t.config.TEMPLATES_DIR);
  await seedReference(t.app.db, t.config.REFERENCE_DIR);
  await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN, { bills: ['HB2402', 'SB6137'] }), {});
  await t.app.bus.drain();
});
afterAll(async () => {
  await t.close();
});

describe('templates and reference', () => {
  it('lists the twelve templates with tags, parts, slots and tokens', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/templates', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.length).toBe(12);
    const sales = list.find((x: any) => x.id === 'sales-use-tax-exemption');
    expect(sales).toMatchObject({ kind: 'document', mode: 'limited', version: 1 });
    expect(sales.tags).toContain('tax:sales-use');
    expect(sales.parts).toContain('II.B');
    const filtered = await t.app.inject({ method: 'GET', url: '/api/v1/templates?taxType=sales-use', headers: await t.as(users.drafter) });
    expect(filtered.json().every((x: any) => x.tags.includes('tax:sales-use'))).toBe(true);
    const one = await t.app.inject({ method: 'GET', url: '/api/v1/templates/sales-use-tax-exemption', headers: await t.as(users.drafter) });
    expect(one.json().html).toContain('data-role="cash-receipts"');
    expect(one.headers.etag).toBeTruthy();
  });

  it('serves reference sets and the base template context', async () => {
    const fy = await t.app.inject({ method: 'GET', url: '/api/v1/reference/fiscal-years', headers: await t.as(users.viewer) });
    expect(fy.statusCode).toBe(200);
    expect(fy.json().biennia).toEqual(['2025-27', '2027-29', '2029-31']);
    const jobs = await t.app.inject({ method: 'GET', url: '/api/v1/reference/job-classes', headers: await t.as(users.viewer) });
    expect(jobs.json().classes.length).toBeGreaterThan(10);
    const missing = await t.app.inject({ method: 'GET', url: '/api/v1/reference/nope', headers: await t.as(users.viewer) });
    expect(missing.statusCode).toBe(404);
    const ctx = await t.app.inject({ method: 'GET', url: '/api/v1/reference/template-context', headers: await t.as(users.drafter) });
    expect(ctx.json().fy[0].label).toBe('FY 2026');
    expect(ctx.json().ref.salary.EXCISE_TAX_EX_2).toBe('59,844');
  });

  it('template write routes are gone', async () => {
    expect((await t.app.inject({ method: 'PUT', url: '/api/v1/templates/no-fiscal-impact', headers: await t.as(users.admin), payload: { description: 'x' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/templates/sales-use-tax-exemption/preview', headers: await t.as(users.drafter) })).statusCode).toBe(404);
  });
});

describe('notes: create, document autosave with If-Match, comments', () => {
  it('a reviewer creates a note on SHB 2402 from the sales-use-tax-exemption template', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: await t.as(users.reviewer),
      payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'sales-use-tax-exemption', drafterId: 'dev-drafter' },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    revisionId = s.noteRevisionId;
    expect(s).toMatchObject({ billKey: 'WA:2025-26:HB2402', versionCode: 'S', versionLabel: 'SHB 2402', state: 'draft', headVersion: 1, templateId: 'sales-use-tax-exemption', editable: true, reviewer: null });
    expect(s).not.toHaveProperty('priority');
    expect(s).not.toHaveProperty('confidential');
    expect(s).not.toHaveProperty('deadlines');
    expect(s.drafter.userId).toBe('dev-drafter');
    expect(s.billTitle).toMatch(/phthalates/i);
    // Events for the workflow and search modules.
    const events = (await t.app.db.execute((await import('drizzle-orm')).sql`SELECT type FROM outbox WHERE payload->>'noteRevisionId' = ${revisionId} ORDER BY event_id`)).rows.map((r: any) => r.type);
    expect(events).toEqual(['note.created']);
  });

  it('a drafter creates for themselves; removed fields are rejected', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.drafter), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().drafter.userId).toBe('dev-drafter');
    expect(ok.json().state).toBe('draft');
    const denied = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.drafter), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact', drafterId: 'dev-both' } });
    expect(denied.statusCode).toBe(403);
    const unknownVersion = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S9', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter' } });
    expect(unknownVersion.statusCode).toBe(400);
    const noTemplate = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', drafterId: 'dev-drafter' } });
    expect(noTemplate.statusCode).toBe(400);
  });

  it('the head document is the instantiated template with tokens filled and slots highlighted', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/document`, headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    const d = res.json();
    expect(d.version).toBe(1);
    expect(d.mode).toBe('limited');
    const doc = d.doc as PMNode;
    const billNo = findAll(doc, 'slot').find((s) => s.attrs?.slot === 'bill.number')!;
    expect(textOf(billNo)).toBe('2402 S HB');
    expect(findAll(doc, 'noteTable').some((n) => n.attrs?.role === 'cash-receipts')).toBe(true);
    const fte = findAll(doc, 'noteTable').find((n) => n.attrs?.role === 'fte-by-class')!;
    expect((fte.content ?? []).filter((r) => r.attrs?.rowKind === 'class').length).toBe(12);
  });

  it('visibility follows the permission matrix', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.viewer) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.drafter) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.both) })).statusCode).toBe(200); // reviewer role
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.reviewer) })).statusCode).toBe(200);
    const denial = (await t.app.db.execute((await import('drizzle-orm')).sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'permission.denied' AND object_id = ${revisionId}`)).rows[0] as any;
    expect(Number(denial.n)).toBeGreaterThanOrEqual(1);
    const onBill = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/notes', headers: await t.as(users.viewer) });
    expect(onBill.json()).toEqual([]);
    const onBillReviewer = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/notes', headers: await t.as(users.reviewer) });
    expect(onBillReviewer.json().map((n: any) => n.noteRevisionId)).toContain(revisionId);
    const mine = await t.app.inject({ method: 'GET', url: '/api/v1/notes?assignee=me', headers: await t.as(users.drafter) });
    expect(mine.json().map((n: any) => n.noteRevisionId)).toContain(revisionId);
  });

  it('autosave uses If-Match: a stale version gets 412 with the current head', async () => {
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/document`, headers: await t.as(users.drafter) })).json();
    const doc = head.doc as PMNode;
    // Fill two receipts cells.
    const setCell = (slot: string, text: string) => {
      const cell = findAll(doc, 'noteCell').find((c) => c.attrs?.slot === slot)!;
      cell.content = [{ type: 'text', text }];
    };
    setCell('receipts.gf.fy1', '-4310000');
    setCell('receipts.gf.fy2', '-10800000');
    const noMatch = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: await t.as(users.drafter), payload: { doc, mode: 'limited' } });
    expect(noMatch.statusCode).toBe(400);
    const saved = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc, mode: 'limited', clientId: 'c1' } });
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.version).toBe(2);
    expect(saved.headers.etag).toBe('"2"');
    // The server recomputed: biennium sums, totals, formatted currency, estimate data.
    const gf = body.estimateData.revenue.find((r: any) => r.key === 'gf');
    expect(gf.fy['2026']).toBe(-4310000);
    expect(gf.biennia['2025-27']).toBe(-15110000);
    expect(body.validation.ok).toBe(true);
    expect(body.validation.unfilledSlots.length).toBeGreaterThan(0);
    const reread = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/document`, headers: await t.as(users.drafter) })).json();
    const bien = findAll(reread.doc as PMNode, 'noteCell').find((c) => c.attrs?.computed === 'sum(receipts.gf.fy1,receipts.gf.fy2)')!;
    expect(textOf(bien)).toBe('(15,110,000)');
    // Stale save.
    const stale = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc, mode: 'limited' } });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().details.version).toBe(2);
    expect(stale.json().details.updatedBy).toBe('dev-drafter');
    expect(stale.json().details.doc.type).toBe('doc');
    // `force` is not a query parameter any more; the stale save is still refused.
    const forced = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document?force=true`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc, mode: 'limited' } });
    expect(forced.statusCode).toBe(412);
    const versions = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/versions`, headers: await t.as(users.drafter) })).json();
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    const v1 = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/versions/1`, headers: await t.as(users.reviewer) });
    expect(v1.json().version).toBe(1);
  });

  it('only the assigned drafter may edit; reviewers and other drafters get 403', async () => {
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/document`, headers: await t.as(users.reviewer) })).json();
    const asReviewer = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: { ...(await t.as(users.reviewer)), 'if-match': `"${head.version}"` }, payload: { doc: head.doc, mode: 'limited' } });
    expect(asReviewer.statusCode).toBe(403);
    const asOther = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: { ...(await t.as(users.both)), 'if-match': `"${head.version}"` }, payload: { doc: head.doc, mode: 'limited' } });
    expect(asOther.statusCode).toBe(403);
  });

  it('comments anchor to ranges and survive edits; replies, resolve, delete', async () => {
    const created = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/comments`, headers: await t.as(users.reviewer), payload: { anchorText: 'Retail Sales Tax', body: 'Check the source line', id: 'c_test1' } });
    expect(created.statusCode).toBe(201);
    // The drafter marks the range in the document and saves.
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/document`, headers: await t.as(users.drafter) })).json();
    const doc = head.doc as PMNode;
    const target = findAll(doc, 'slot').find((s) => s.attrs?.slot === 'receipts.gf.source')!;
    target.content = [{ type: 'text', text: 'Retail Sales Tax', marks: [{ type: 'comment', attrs: { commentId: 'c_test1', resolved: false } }] }];
    const saved = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': `"${head.version}"` }, payload: { doc, mode: 'limited' } });
    expect(saved.statusCode).toBe(200);
    let threads = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/comments`, headers: await t.as(users.drafter) })).json();
    expect(threads[0]).toMatchObject({ id: 'c_test1', status: 'open', detached: false, anchorText: 'Retail Sales Tax' });
    expect(threads[0].messages[0]).toMatchObject({ authorId: 'dev-reviewer', body: 'Check the source line' });
    // Reply and resolve.
    const reply = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/comments/c_test1/messages`, headers: await t.as(users.drafter), payload: { body: 'Fixed' } });
    expect(reply.statusCode).toBe(201);
    const resolved = await t.app.inject({ method: 'PATCH', url: `/api/v1/notes/${revisionId}/comments/c_test1`, headers: await t.as(users.reviewer), payload: { status: 'resolved' } });
    expect(resolved.statusCode).toBe(200);
    threads = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/comments`, headers: await t.as(users.drafter) })).json();
    expect(threads[0].status).toBe('resolved');
    expect(threads[0].messages.length).toBe(2);
    // Viewers cannot comment; the drafter cannot delete the reviewer's thread.
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/comments`, headers: await t.as(users.viewer), payload: { anchorText: 'x', body: 'y' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/notes/${revisionId}/comments/c_test1`, headers: await t.as(users.drafter) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/notes/${revisionId}/comments/c_test1`, headers: await t.as(users.reviewer) })).statusCode).toBe(204);
  });

  it('writes the note history to the audit log; the removed note routes answer 404', async () => {
    const rows = (await t.app.db.execute((await import('drizzle-orm')).sql`SELECT action FROM audit_log WHERE object_id = ${revisionId}`)).rows as any[];
    expect(rows.map((a) => a.action)).toEqual(expect.arrayContaining(['note.create', 'note.document_save', 'note.comment_create', 'note.comment_delete']));
    for (const [method, path] of [
      ['GET', 'audit'],
      ['GET', 'validate'],
      ['GET', 'diff?from=1&to=2'],
      ['POST', 'versions'],
      ['POST', 'versions/1/restore'],
      ['GET', 'exports'],
      ['GET', 'lock'],
      ['GET', 'context'],
    ] as const) {
      expect((await t.app.inject({ method, url: `/api/v1/notes/${revisionId}/${path}`, headers: await t.as(users.drafter) })).statusCode).toBe(404);
    }
  });

  it('internal notes are not indexed for search', async () => {
    await t.app.bus.drain();
    await t.app.searchSvc.backend.refresh();
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=SHB%202402', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect((res.json().direct.related.fiscal_notes as any[]).map((n) => n.note_id)).not.toContain(`fn:int:${revisionId}`);
    const unconsumed = (await t.app.db.execute((await import('drizzle-orm')).sql`SELECT count(*)::int AS n FROM outbox_consumptions WHERE consumer = 'search:notes'`)).rows[0] as any;
    expect(Number(unconsumed.n)).toBe(0);
  });
});
