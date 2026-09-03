import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
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
let noteId: string;

type U = (typeof users)[keyof typeof users];
const send = async (u: U, event: string, extra: Record<string, unknown> = {}) => t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/workflow`, headers: await t.as(u), payload: { event, ...extra } });
const workflow = async (u: U) => (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/workflow`, headers: await t.as(u) })).json();
const threads = async (u: U) => (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/comments`, headers: await t.as(u) })).json() as any[];
const rows = async () => (await t.app.db.execute(sql`SELECT requested_by, summary, resolved_at, resolution FROM note_change_requests WHERE note_revision_id = ${noteId} ORDER BY requested_at`)).rows as any[];
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
  await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN, { bills: ['SB6137'] }), {});
  await drain();
});
afterAll(async () => {
  await drain();
  await t.close();
});

describe('change requests', () => {
  it('requesting changes records the message and leaves the open threads for the drafter', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter' } });
    expect(created.statusCode).toBe(201);
    noteId = created.json().noteRevisionId;
    await drain();
    // The drafter marks a range with a comment id and submits.
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/document`, headers: await t.as(users.drafter) })).json();
    const doc = head.doc;
    const walk = (n: any, fn: (x: any) => void) => {
      fn(n);
      (n.content ?? []).forEach((c: any) => walk(c, fn));
    };
    walk(doc, (n) => {
      if (n.type === 'paragraph' && n.attrs?.slot === 'narrative.proposal') n.content = [{ type: 'text', text: 'Authorizes sports wagering over the internet.', marks: [{ type: 'comment', attrs: { commentId: 'c_cr1', resolved: false } }] }];
    });
    expect((await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc, mode: 'limited' } })).statusCode).toBe(200);
    await drain();
    expect((await send(users.drafter, 'SUBMIT')).statusCode).toBe(201);
    // The reviewer leaves an inline thread, then requests changes.
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/comments`, headers: await t.as(users.reviewer), payload: { id: 'c_cr1', anchorText: 'Authorizes sports wagering over the internet.', body: 'Say which section authorizes it' } })).statusCode).toBe(201);
    const refused = await send(users.reviewer, 'REQUEST_CHANGES');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('message_required');
    const res = await send(users.reviewer, 'REQUEST_CHANGES', { message: 'Not ready yet: fill in the cash receipts table and cite the section.' });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('changes_requested');
    const w = await workflow(users.drafter);
    expect(w.changeRequest).toMatchObject({ message: 'Not ready yet: fill in the cash receipts table and cite the section.', by: { userId: 'dev-reviewer', displayName: 'Rae Reviewer' } });
    expect(w.changeRequest.at).toBeTruthy();
    expect((await threads(users.drafter)).filter((c) => c.status === 'open').length).toBe(1);
    const [row] = await rows();
    expect(row).toMatchObject({ requested_by: 'dev-reviewer', resolved_at: null, resolution: null });
  });

  it('resubmitting resolves the request with the drafter’s reply', async () => {
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/comments/c_cr1/messages`, headers: await t.as(users.drafter), payload: { body: 'Section 4' } })).statusCode).toBe(201);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/notes/${noteId}/comments/c_cr1`, headers: await t.as(users.drafter), payload: { status: 'resolved' } })).statusCode).toBe(200);
    expect((await send(users.drafter, 'SUBMIT', { message: 'Table filled, section cited.' })).statusCode).toBe(201);
    expect((await workflow(users.reviewer)).changeRequest).toBeNull();
    const [row] = await rows();
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolution).toBe('Table filled, section cited.');
    // A second round opens a second request; the first stays resolved.
    expect((await send(users.reviewer, 'REQUEST_CHANGES', { message: 'Please fill Part II' })).statusCode).toBe(201);
    const all = await rows();
    expect(all.length).toBe(2);
    expect(all[0].resolved_at).toBeTruthy();
    expect(all[1]).toMatchObject({ summary: 'Please fill Part II', resolved_at: null });
    expect((await workflow(users.drafter)).changeRequest.message).toBe('Please fill Part II');
    expect((await send(users.drafter, 'SUBMIT')).statusCode).toBe(201);
    expect((await rows())[1].resolved_at).toBeTruthy();
    expect((await rows())[1].resolution).toBeNull();
    // History carries the request and the reply.
    const log = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/transitions`, headers: await t.as(users.reviewer) })).json();
    expect(log.map((x: any) => [x.event, x.comment])).toEqual([
      ['SUBMIT', null],
      ['REQUEST_CHANGES', 'Please fill Part II'],
      ['SUBMIT', 'Table filled, section cited.'],
      ['REQUEST_CHANGES', 'Not ready yet: fill in the cash receipts table and cite the section.'],
      ['SUBMIT', null],
    ]);
  });
});
