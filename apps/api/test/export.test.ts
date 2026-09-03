import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import type { Logger } from 'pino';
import { findAll, type PMNode } from '@wa-leg/note-schema';
import { NOTE_TABLES, createTestApp, truncate, users, type TestContext } from './helpers.js';
import { DirectoryFetcher, ingestLegiscanBills, readDataset } from '../src/modules/bills/index.js';
import { seedTemplates } from '../src/modules/templates/index.js';
import { seedReference } from '../src/modules/reference/index.js';
import { seedUsers } from '../src/db/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGISCAN = join(here, 'fixtures', 'legiscan');
const XML_FIXTURES = join(here, '..', '..', '..', 'packages', 'bill-document', 'fixtures');

let t: TestContext;
let noteId: string;

/** Read one entry of a zip (stored or deflated) without a zip library. */
function zipEntry(buf: Buffer, name: string): string {
  let pos = 0;
  while (pos + 30 <= buf.length && buf.readUInt32LE(pos) === 0x04034b50) {
    const method = buf.readUInt16LE(pos + 8);
    const compressed = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const entryName = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf8');
    const dataStart = pos + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compressed);
    if (entryName === name) return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    pos = dataStart + compressed;
  }
  throw new Error(`zip entry ${name} not found`);
}

const drain = async () => {
  await t.app.bus.drain();
  await t.app.bus.drain();
};

beforeAll(async () => {
  t = await createTestApp({ SEARCH_BACKEND: 'postgres' });
  await truncate(t.handle, NOTE_TABLES);
  await seedUsers(t.app.db);
  await seedTemplates(t.app.db, t.config.TEMPLATES_DIR);
  await seedReference(t.app.db, t.config.REFERENCE_DIR);
  await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN, { bills: ['HB2402'] }), {});
  await drain();
  // A note with figures, a formula, a citation and a comment.
  const created = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'sales-use-tax-exemption', drafterId: 'dev-drafter' } });
  noteId = created.json().noteRevisionId;
  await drain();
  const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/document`, headers: await t.as(users.drafter) })).json();
  const doc = head.doc as PMNode;
  const setCell = (slot: string, text: string) => {
    const cell = findAll(doc, 'noteCell').find((c) => c.attrs?.slot === slot)!;
    cell.content = [{ type: 'text', text }];
  };
  setCell('receipts.gf.fy1', '-4310000');
  setCell('receipts.gf.fy2', '-10800000');
  const proposal = findAll(doc, 'paragraph').find((p) => p.attrs?.slot === 'narrative.proposal')!;
  proposal.content = [
    { type: 'text', text: 'The exemption applies per ' },
    { type: 'billCitation', attrs: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', versionLabel: 'SHB 2402', sectionId: 'sec-2', label: 'Sec. 2', citation: 'Section 2 of SHB 2402', href: '/bills/2025-26/HB2402/S#sec-2' } },
    { type: 'text', text: ' with revenue R = ' },
    { type: 'inlineMath', attrs: { latex: '\\frac{a}{b} \\times 10^{3}' } },
    { type: 'text', text: ' (reviewed)', marks: [{ type: 'comment', attrs: { commentId: 'c_exp', resolved: false } }] },
  ];
  await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/comments`, headers: await t.as(users.reviewer), payload: { anchorText: '(reviewed)', body: 'Check the multiplier', id: 'c_exp' } });
  const saved = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc, mode: 'limited' } });
  if (saved.statusCode !== 200) throw new Error(saved.body);
  await drain();
});
afterAll(async () => {
  await t.close();
});

describe('exports', () => {
  it('HTML renders the tables, currency, citation link and KaTeX math', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/export?format=html`, headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="SHB_2402_fiscal_note_v2.html"/);
    expect(res.body).toContain('<table class="note-table"');
    expect(res.body).toContain('(15,110,000)');
    expect(res.body).toContain('class="katex"');
    expect(res.body).toContain('<math');
    expect(res.body).toMatch(/href="http:\/\/localhost:5173\/bills\/2025-26\/HB2402\/S#sec-2"/);
    expect(res.body).toContain('Form FN (Rev 1/00)');
    expect(res.body).not.toContain('mark class="comment"');
  });

  it('DOCX is a Word package with the table, bold totals and OMML math; comment marks are dropped', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/export?format=docx`, headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    const buf = res.rawPayload;
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const xml = zipEntry(buf, 'word/document.xml');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('(15,110,000)');
    expect(xml).toContain('<m:oMath>');
    expect(xml).toContain('<m:f>'); // fraction
    expect(xml).toContain('<m:sSup>'); // superscript
    expect(xml).toContain('Sec. 2');
    expect(xml).not.toContain('commentRangeStart');
    const footer = zipEntry(buf, 'word/footer1.xml');
    expect(footer).toContain('FNS062');
  });

  it('PDF renders through Chromium', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/export?format=pdf`, headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(10_000);
  }, 60_000);

  it('FNS XML emits slot values and table cells, and refuses while required slots are empty', async () => {
    const refused = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/export?format=xml`, headers: await t.as(users.drafter) });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().details.unfilledSlots.length).toBeGreaterThan(0);
    // Fill every required slot, then export.
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/document`, headers: await t.as(users.drafter) })).json();
    const doc = head.doc as PMNode;
    const fill = (n: PMNode) => {
      for (const c of n.content ?? []) {
        const slot = c.attrs?.slot as string | undefined;
        const editable = slot && !c.attrs?.readonly && !c.attrs?.computed && c.type !== 'checkbox';
        const required = c.type === 'slot' ? c.attrs?.required !== false : !c.attrs?.optional;
        if (editable && required) {
          const text = (c.content ?? []).map((x) => x.text ?? (x.content ?? []).map((y) => y.text ?? '').join('')).join('').trim();
          const numeric = ['money', 'fte', 'money-thousands', 'int', 'pct'].includes(String(c.attrs?.slotType ?? ''));
          if (!text) {
            if (c.type === 'bulletList' || c.type === 'orderedList') c.content = [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'n/a' }] }] }];
            else c.content = [{ type: 'text', text: numeric ? '0' : 'n/a' }];
          }
        }
        if (c.type !== 'slot' && !(c.type === 'noteCell' && slot)) fill(c);
      }
    };
    fill(doc);
    const saved = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': `"${head.version}"` }, payload: { doc, mode: 'limited' } });
    expect(saved.statusCode).toBe(200);
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/export?format=xml`, headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.body).toContain('<FiscalNote schemaVersion="placeholder"');
    expect(res.body).toContain('<BillNumber>SHB 2402</BillNumber>');
    expect(res.body).toMatch(/<Field path="receipts\.gf\.fy1" type="money" value="-4310000">\(4,310,000\)<\/Field>/);
    expect(res.body).toContain('<Fund code="001-1"');
    expect(res.body).toContain('<Biennium id="2025-27">-15110000</Biennium>');
    expect(res.body).toContain('<Section part="II.B"');
  });

  it('exports are recorded and audited', async () => {
    const { sql } = await import('drizzle-orm');
    const stored = (await t.app.db.execute(sql`SELECT count(*)::int AS n FROM note_exports WHERE note_revision_id = ${noteId} AND status = 'done'`)).rows[0] as any;
    expect(Number(stored.n)).toBeGreaterThanOrEqual(4);
    const audit = (await t.app.db.execute(sql`SELECT after FROM audit_log WHERE action = 'note.export' AND object_id = ${noteId}`)).rows as any[];
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(audit[0].after.format).toBeTruthy();
    const events = (await t.app.db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE type = 'note.exported'`)).rows[0] as any;
    expect(Number(events.n)).toBeGreaterThanOrEqual(4);
  });

  it('viewers see nothing until publication, then the published version beside the bill', async () => {
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/export?format=html`, headers: await t.as(users.viewer) })).statusCode).toBe(403);
    const send = async (u: (typeof users)[keyof typeof users], event: string) => t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/workflow`, headers: await t.as(u), payload: { event } });
    expect((await send(users.drafter, 'SUBMIT')).statusCode).toBe(201);
    expect((await send(users.reviewer, 'APPROVE')).json().state).toBe('approved');
    await drain();
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}`, headers: await t.as(users.viewer) })).statusCode).toBe(403);
    expect((await send(users.reviewer, 'PUBLISH')).json().state).toBe('published');
    await drain();
    const summary = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}`, headers: await t.as(users.viewer) })).json();
    expect(summary.state).toBe('published');
    expect(summary.approvedVersion).toBe(summary.headVersion);
    expect(summary.publishedVersion).toBe(summary.approvedVersion);
    const versions = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/versions`, headers: await t.as(users.viewer) })).json();
    expect(versions[0].label).toBe('Approved');
    // The bill page lists it for anyone; the approved document is readable.
    const onBill = (await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/notes', headers: await t.as(users.viewer) })).json();
    expect(onBill.map((n: any) => n.noteRevisionId)).toContain(noteId);
    const approvedDoc = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/versions/${summary.approvedVersion}`, headers: await t.as(users.viewer) });
    expect(approvedDoc.statusCode).toBe(200);
    // Exports for viewers default to the approved version; other versions are refused.
    const pdfLink = await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/export?format=html`, headers: await t.as(users.viewer) });
    expect(pdfLink.statusCode).toBe(200);
    expect(pdfLink.headers['x-document-version']).toBe(String(summary.approvedVersion));
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/export?format=html&version=1`, headers: await t.as(users.viewer) })).statusCode).toBe(403);
    const publish = (await t.app.db.execute((await import('drizzle-orm')).sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'note.publish' AND object_id = ${noteId}`)).rows[0] as any;
    expect(Number(publish.n)).toBe(1);
  });
});
