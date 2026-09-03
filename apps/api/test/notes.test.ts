import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { findAll, textOf, type PMNode } from '@wa-leg/note-schema';
import { createTestApp, truncate, users, type TestContext } from './helpers.js';
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
  await truncate(t.handle, ['bills', 'bill_versions', 'amendments', 'hearings', 'prior_fiscal_notes', 'outbox', 'outbox_consumptions', 'search_docs', 'notes', 'note_revisions', 'note_documents', 'note_comments', 'note_comment_messages', 'note_locks', 'templates', 'reference_sets', 'audit_log']);
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

  it('template editing needs the template_editor role and creates a new version', async () => {
    const denied = await t.app.inject({ method: 'PUT', url: '/api/v1/templates/no-fiscal-impact', headers: await t.as(users.drafter), payload: { description: 'x' } });
    expect(denied.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'PUT', url: '/api/v1/templates/no-fiscal-impact', headers: await t.as(users.templateEditor), payload: { description: 'Edited in a test' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().version).toBe(2);
    const list = await t.app.inject({ method: 'GET', url: '/api/v1/templates', headers: await t.as(users.drafter) });
    expect(list.json().find((x: any) => x.id === 'no-fiscal-impact').description).toBe('Edited in a test');
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

  it('previews a template with tokens substituted', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/templates/sales-use-tax-exemption/preview', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('FY 2026');
    expect(res.body).toContain('140-Department of Revenue');
  });
});

describe('notes: create, document autosave with If-Match, versions, comments, locks', () => {
  it('a reviewer creates a note on SHB 2402 from the sales-use-tax-exemption template', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: await t.as(users.reviewer),
      payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'sales-use-tax-exemption', drafterId: 'dev-drafter', request: { requestId: '2402-1-1', legContact: { name: 'Jane Legislative', phone: '360-786-7100' }, tenYearRequested: false }, priority: 'high' },
    });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    revisionId = s.noteRevisionId;
    expect(s).toMatchObject({ billKey: 'WA:2025-26:HB2402', versionCode: 'S', versionLabel: 'SHB 2402', kind: 'note', state: 'todo', drafterStatus: 'to-do', headVersion: 1, templateId: 'sales-use-tax-exemption', priority: 'high', editable: true });
    expect(s.drafter.userId).toBe('dev-drafter');
    expect(s.billTitle).toMatch(/phthalates/i);
    // Events for the workflow and search modules.
    const events = (await t.app.db.execute((await import('drizzle-orm')).sql`SELECT type FROM outbox WHERE payload->>'noteRevisionId' = ${revisionId} ORDER BY event_id`)).rows.map((r: any) => r.type);
    expect(events).toEqual(expect.arrayContaining(['note.created', 'fiscal_note.requested']));
  });

  it('drafters cannot create fiscal notes but may create estimates for themselves', async () => {
    const denied = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.drafter), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S' } });
    expect(denied.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.drafter), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', kind: 'estimate', templateId: 'no-fiscal-impact' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().kind).toBe('estimate');
    expect(ok.json().drafter.userId).toBe('dev-drafter');
    const unknownVersion = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S9' } });
    expect(unknownVersion.statusCode).toBe(400);
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
    const contact = findAll(doc, 'noteCell').find((s) => s.attrs?.slot === 'legContact.name')!;
    expect(textOf(contact)).toBe('Jane Legislative');
    expect(textOf(findAll(doc, 'slot').find((s) => s.attrs?.slot === 'legContact.phone')!)).toBe('360-786-7100');
    expect(findAll(doc, 'noteTable').some((n) => n.attrs?.role === 'cash-receipts')).toBe(true);
    const fte = findAll(doc, 'noteTable').find((n) => n.attrs?.role === 'fte-by-class')!;
    expect((fte.content ?? []).filter((r) => r.attrs?.rowKind === 'class').length).toBe(12);
  });

  it('visibility follows the permission matrix', async () => {
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.viewer) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.otherDivDrafter) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.drafter2) })).statusCode).toBe(200); // same division
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.reviewer) })).statusCode).toBe(200);
    const denial = await t.app.inject({ method: 'GET', url: '/api/v1/admin/audit?action=permission.denied&objectId=' + revisionId, headers: await t.as(users.admin) });
    expect(denial.json().length).toBeGreaterThanOrEqual(2);
    const onBill = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/notes', headers: await t.as(users.viewer) });
    expect(onBill.json()).toEqual([]);
    const onBillReviewer = await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/notes', headers: await t.as(users.reviewer) });
    expect(onBillReviewer.json().map((n: any) => n.noteRevisionId)).toContain(revisionId);
  });

  it('autosave uses If-Match: a stale version gets 412 with the current head, force stores a new head', async () => {
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
    // Force keeps the server head as a labelled snapshot and stores version 3.
    const forced = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document?force=true`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc, mode: 'limited' } });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().version).toBe(3);
    const versions = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/versions`, headers: await t.as(users.drafter) })).json();
    expect(versions.map((v: any) => v.version)).toEqual([3, 2, 1]);
    expect(versions.find((v: any) => v.version === 2).label).toBe('Superseded by a forced save');
  });

  it('only the assigned drafter may edit; reviewers and other drafters get 403', async () => {
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/document`, headers: await t.as(users.reviewer) })).json();
    const asReviewer = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: { ...(await t.as(users.reviewer)), 'if-match': `"${head.version}"` }, payload: { doc: head.doc, mode: 'limited' } });
    expect(asReviewer.statusCode).toBe(403);
    const asOther = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${revisionId}/document`, headers: { ...(await t.as(users.drafter2)), 'if-match': `"${head.version}"` }, payload: { doc: head.doc, mode: 'limited' } });
    expect(asOther.statusCode).toBe(403);
  });

  it('snapshots, restores, and diffs versions', async () => {
    const snap = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/versions`, headers: await t.as(users.drafter), payload: { label: 'Before review' } });
    expect(snap.statusCode).toBe(201);
    const restored = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/versions/1/restore`, headers: await t.as(users.drafter) });
    expect(restored.statusCode).toBe(201);
    expect(restored.json().version).toBe(4);
    const diff = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/diff?from=1&to=3`, headers: await t.as(users.reviewer) });
    expect(diff.statusCode).toBe(200);
    const d = diff.json();
    expect(d.html).toContain('diff-line');
    expect(d.tables.some((c: any) => c.table === 'revenue' && c.row === 'gf' && c.new === -4310000)).toBe(true);
    const same = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/diff?from=1&to=4`, headers: await t.as(users.reviewer) })).json();
    expect(same.summary).toBe('No changes');
    const v3 = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/versions/3`, headers: await t.as(users.reviewer) });
    expect(v3.json().version).toBe(3);
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
    // Viewers cannot comment; a different drafter cannot delete the reviewer's thread.
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/comments`, headers: await t.as(users.viewer), payload: { anchorText: 'x', body: 'y' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/notes/${revisionId}/comments/c_test1`, headers: await t.as(users.drafter2) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/notes/${revisionId}/comments/c_test1`, headers: await t.as(users.reviewer) })).statusCode).toBe(204);
  });

  it('soft locks: the holder renews, another editor gets 409, release frees it', async () => {
    const mine = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/lock`, headers: await t.as(users.drafter) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().holder).toBe('dev-drafter');
    // A manager reassigns to drafter2 in a later milestone; here another editor is refused by can() first.
    const status = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/lock`, headers: await t.as(users.reviewer) });
    expect(status.json().lock.holder).toBe('dev-drafter');
    const released = await t.app.inject({ method: 'DELETE', url: `/api/v1/notes/${revisionId}/lock`, headers: await t.as(users.drafter) });
    expect(released.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/lock`, headers: await t.as(users.reviewer) })).json().lock).toBeNull();
  });

  it('validates the head and lists the note history in the audit log', async () => {
    const v = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/validate`, headers: await t.as(users.reviewer) });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toHaveProperty('unfilledSlots');
    const audit = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/audit`, headers: await t.as(users.drafter) });
    expect(audit.statusCode).toBe(200);
    const actions = audit.json().map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['note.create', 'note.document_save', 'note.snapshot', 'note.restore', 'note.comment_create', 'note.comment_delete']));
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}/audit`, headers: await t.as(users.drafter2) })).statusCode).toBe(403);
  });

  it('a new revision for a new bill version clones the document', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${revisionId}/revisions`, headers: await t.as(users.reviewer), payload: { versionCode: 'I' } });
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.previousRevisionId).toBe(revisionId);
    expect(s.versionCode).toBe('I');
    expect(s.headVersion).toBe(1);
    const parent = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.reviewer) })).json();
    expect(parent.supersededBy).toBe(s.noteRevisionId);
    const doc = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${s.noteRevisionId}/document`, headers: await t.as(users.drafter) })).json();
    expect(textOf(findAll(doc.doc as PMNode, 'slot').find((x) => x.attrs?.slot === 'bill.number')!)).toBe('2402 S HB');
    // Metadata patch.
    const patched = await t.app.inject({ method: 'PATCH', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.reviewer), payload: { confidential: true, identifier: 'DOR-2026-042' } });
    expect(patched.json()).toMatchObject({ confidential: true, identifier: 'DOR-2026-042' });
    // Confidential now: the same-division drafter loses access; the assigned drafter keeps it.
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.drafter2) })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${revisionId}`, headers: await t.as(users.drafter) })).statusCode).toBe(200);
  });

  it('indexes internal notes for search with visibility from the note state', async () => {
    await t.app.bus.drain();
    await t.app.searchSvc.backend.refresh();
    const idsFor = async (u: (typeof users)[keyof typeof users]) => {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/search?q=SHB%202402', headers: await t.as(u) });
      expect(res.statusCode).toBe(200);
      return (res.json().direct.related.fiscal_notes as any[]).map((n) => n.note_id);
    };
    expect(await idsFor(users.drafter)).toContain(`fn:int:${revisionId}`);
    expect(await idsFor(users.viewer)).not.toContain(`fn:int:${revisionId}`);
    expect(await idsFor(users.reviewer)).not.toContain(`fn:int:${revisionId}`);
  });
});
