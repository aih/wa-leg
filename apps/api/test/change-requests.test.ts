import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { createTestApp, truncate, users, type TestContext } from './helpers.js';
import { DirectoryFetcher, ingestLegiscanBills, readDataset } from '../src/modules/bills/index.js';
import { seedTemplates } from '../src/modules/templates/index.js';
import { seedReference } from '../src/modules/reference/index.js';
import { seedUsers } from '../src/db/seed.js';
import { NotesService } from '../src/modules/notes/service.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGISCAN = join(here, 'fixtures', 'legiscan');
const XML_FIXTURES = join(here, '..', '..', '..', 'packages', 'bill-document', 'fixtures');

let t: TestContext;
let noteId: string;

type U = (typeof users)[keyof typeof users];
const send = async (u: U, event: string, extra: Record<string, unknown> = {}) => t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/transitions`, headers: await t.as(u), payload: { event, ...extra } });
const requests = async (u: U) => (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/change-requests`, headers: await t.as(u) })).json() as any[];
const drain = async () => {
  await t.app.bus.drain();
  await t.app.bus.drain();
};

beforeAll(async () => {
  t = await createTestApp({ SEARCH_BACKEND: 'postgres' });
  await truncate(t.handle, ['bills', 'bill_versions', 'amendments', 'hearings', 'prior_fiscal_notes', 'outbox', 'outbox_consumptions', 'search_docs', 'notes', 'note_revisions', 'note_documents', 'note_comments', 'note_comment_messages', 'note_locks', 'note_change_requests', 'note_change_request_items', 'templates', 'reference_sets', 'audit_log', 'workflow_instances', 'workflow_transitions', 'workflow_assignments', 'workflow_deadlines', 'notifications']);
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
  it('splits bullet lines from the summary', () => {
    expect(NotesService.splitRequest('Two things before I can approve:\n- Fill Part II.B\n2. Cite section 3\nThanks')).toEqual({ summary: 'Two things before I can approve:\nThanks', items: ['Fill Part II.B', 'Cite section 3'] });
    expect(NotesService.splitRequest('Please fill Part II')).toEqual({ summary: 'Please fill Part II', items: [] });
  });

  it('requesting changes records an itemised request from the comment and the open threads', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter', request: { requestId: 'cr-1' } } });
    expect(created.statusCode).toBe(201);
    noteId = created.json().noteRevisionId;
    await drain();
    // The drafter starts, marks a range with a comment id, and submits.
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
    expect((await send(users.drafter, 'SUBMIT_FOR_REVIEW')).statusCode).toBe(201);
    expect((await send(users.reviewer, 'CLAIM_REVIEW')).statusCode).toBe(201);
    // The reviewer leaves an inline thread, then requests changes with two bullet items.
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/comments`, headers: await t.as(users.reviewer), payload: { id: 'c_cr1', anchorText: 'Authorizes sports wagering over the internet.', body: 'Say which section authorizes it' } })).statusCode).toBe(201);
    const res = await send(users.reviewer, 'REQUEST_CHANGES', { comment: 'Not ready yet.\n- Fill in the cash receipts table\n- Add the effective date sentence' });
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('changes_requested');
    const [cr] = await requests(users.drafter);
    expect(cr).toMatchObject({ status: 'open', event: 'REQUEST_CHANGES', requestedBy: 'dev-reviewer', requestedByName: 'Rae Reviewer', summary: 'Not ready yet.', transitionSeq: res.json().seq, openItems: 3 });
    expect(cr.items.map((i: any) => [i.body, i.commentId])).toEqual([
      ['Fill in the cash receipts table', null],
      ['Add the effective date sentence', null],
      ['Say which section authorizes it', 'c_cr1'],
    ]);
    // Recording the same transition twice is idempotent.
    const again = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests`, headers: await t.as(users.reviewer), payload: { transitionSeq: res.json().seq, summary: 'dup' } });
    expect(again.statusCode).toBe(201);
    expect((await requests(users.drafter)).length).toBe(1);
  });

  it('the drafter cannot resubmit while items are open; addressing an item answers and resolves its thread', async () => {
    const blocked = await send(users.drafter, 'SUBMIT_FOR_REVIEW');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('change_request_open');
    expect(blocked.json().details.openItems).toBe(3);
    const [cr] = await requests(users.drafter);
    const threadItem = cr.items.find((i: any) => i.commentId === 'c_cr1');
    // A viewer may not address items.
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests/${cr.id}/items/${threadItem.id}/address`, headers: await t.as(users.viewer), payload: { resolution: 'x' } })).statusCode).toBe(403);
    for (const item of cr.items) {
      const r = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests/${cr.id}/items/${item.id}/address`, headers: await t.as(users.drafter), payload: { resolution: `Done: ${item.body}` } });
      expect(r.statusCode).toBe(200);
    }
    const [after] = await requests(users.reviewer);
    expect(after.openItems).toBe(0);
    expect(after.items.every((i: any) => i.status === 'addressed' && i.addressedByName === 'Dana Drafter' && i.resolutionVersion === 2)).toBe(true);
    const threads = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/comments`, headers: await t.as(users.reviewer) })).json();
    expect(threads[0].status).toBe('resolved');
    expect(threads[0].messages.at(-1).body).toBe('Addressed in version 2: Done: Say which section authorizes it');
    // Reopening an item reopens the thread and the request.
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests/${cr.id}/items/${threadItem.id}/reopen`, headers: await t.as(users.reviewer), payload: { reason: 'Cite the section number' } })).statusCode).toBe(200);
    expect((await requests(users.reviewer))[0].openItems).toBe(1);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/comments`, headers: await t.as(users.reviewer) })).json()[0].status).toBe('open');
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests/${cr.id}/close`, headers: await t.as(users.drafter), payload: { resolution: 'All done' } })).statusCode).toBe(409);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests/${cr.id}/items/${threadItem.id}/address`, headers: await t.as(users.drafter), payload: { resolution: 'Cited section 4 of SB 6137' } })).statusCode).toBe(200);
  });

  it('closing with a resolution, or resubmitting, settles the request; the reviewer sees the resolutions', async () => {
    const [cr] = await requests(users.drafter);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests/${cr.id}/close`, headers: await t.as(users.drafter), payload: { resolution: 'Table filled, sentence added, section cited.' } })).statusCode).toBe(200);
    const [closed] = await requests(users.reviewer);
    expect(closed).toMatchObject({ status: 'closed', closedBy: 'dev-drafter', resolution: 'Table filled, sentence added, section cited.', resolutionVersion: 2 });
    expect((await send(users.drafter, 'SUBMIT_FOR_REVIEW', { comment: 'Second draft' })).statusCode).toBe(201);
    expect((await send(users.reviewer, 'CLAIM_REVIEW')).statusCode).toBe(201);
    // A second request with no bullets and no threads becomes one item; resubmitting after addressing it closes it with the submit comment.
    const second = await send(users.reviewer, 'REQUEST_CHANGES', { comment: 'Please fill Part II' });
    expect(second.statusCode).toBe(201);
    const list = await requests(users.drafter);
    expect(list.length).toBe(2);
    expect(list[0].items.map((i: any) => i.body)).toEqual(['Please fill Part II']);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/change-requests/${list[0].id}/items/${list[0].items[0].id}/address`, headers: await t.as(users.drafter), payload: { resolution: 'Filled' } })).statusCode).toBe(200);
    expect((await send(users.drafter, 'SUBMIT_FOR_REVIEW', { comment: 'Part II filled' })).statusCode).toBe(201);
    const settled = await requests(users.reviewer);
    expect(settled[0]).toMatchObject({ status: 'closed', resolution: 'Part II filled' });
    const audit = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/audit`, headers: await t.as(users.reviewer) })).json().map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['note.change_request_open', 'note.change_request_item_addressed', 'note.change_request_item_reopened', 'note.change_request_close']));
  });
});
