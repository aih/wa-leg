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
const workflow = async (u: U, id = noteId) => (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${id}/workflow`, headers: await t.as(u) })).json();
const send = async (u: U, event: string, extra: Record<string, unknown> = {}, id = noteId) => t.app.inject({ method: 'POST', url: `/api/v1/notes/${id}/workflow`, headers: await t.as(u), payload: { event, ...extra } });
const summary = async (u: U, id = noteId) => t.app.inject({ method: 'GET', url: `/api/v1/notes/${id}`, headers: await t.as(u) });
const events = (w: any) => w.availableEvents.map((e: any) => e.type);
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
  await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN, { bills: ['HB2402', 'SB6137'] }), {});
  await drain();
});
afterAll(async () => {
  await t.close();
});

describe('workflow: draft, review, changes, approval, publication', () => {
  it('a reviewer creates a note in draft with its drafter', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter' } });
    expect(res.statusCode).toBe(201);
    noteId = res.json().noteRevisionId;
    await drain();
    const w = await workflow(users.drafter);
    expect(w).toMatchObject({ state: 'draft', drafter: { userId: 'dev-drafter', displayName: 'Dana Drafter' }, reviewer: null, version: 0, editable: true, changeRequest: null });
    expect(w.availableEvents).toEqual([{ type: 'SUBMIT', label: 'Submit for review' }]);
    expect(events(await workflow(users.reviewer))).toEqual([]);
    expect((await workflow(users.reviewer)).editable).toBe(false);
    expect((await summary(users.reviewer)).json()).toMatchObject({ state: 'draft', drafter: { userId: 'dev-drafter' }, reviewer: null, approvedVersion: null, publishedAt: null, publishedVersion: null });
    // A viewer sees neither the note nor its workflow.
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/workflow`, headers: await t.as(users.viewer) })).statusCode).toBe(403);
    // The old transition route is gone.
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notes/${noteId}/transitions`, headers: await t.as(users.drafter), payload: { event: 'SUBMIT' } })).statusCode).toBe(404);
  });

  it('a drafter creates for themselves only; a reviewer must name the drafter', async () => {
    const own = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.drafter), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact' } });
    expect(own.statusCode).toBe(201);
    expect(own.json().drafter.userId).toBe('dev-drafter');
    expect((await workflow(users.drafter, own.json().noteRevisionId)).state).toBe('draft');
    const other = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.drafter), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact', drafterId: 'dev-both' } });
    expect(other.statusCode).toBe(403);
    const nobody = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact' } });
    expect(nobody.statusCode).toBe(400);
    expect(nobody.json().code).toBe('drafter_required');
    const notADrafter = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact', drafterId: 'dev-committee' } });
    expect(notADrafter.statusCode).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.viewer), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact' } })).statusCode).toBe(403);
  });

  it('only the drafter submits; the version guards against stale clients', async () => {
    const wrong = await send(users.reviewer, 'SUBMIT');
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().code).toBe('not_allowed');
    expect(wrong.json().details.allowed).toEqual([]);
    const stale = await send(users.drafter, 'SUBMIT', { expectedVersion: 5 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('version_mismatch');
    const ok = await send(users.drafter, 'SUBMIT', { message: 'Ready', expectedVersion: 0 });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ state: 'in_review', version: 1, seq: 1 });
    await drain();
    expect(events(await workflow(users.reviewer))).toEqual(['REQUEST_CHANGES', 'APPROVE']);
    expect(events(await workflow(users.both))).toEqual(['REQUEST_CHANGES', 'APPROVE']);
    const mine = await workflow(users.drafter);
    expect(mine.editable).toBe(false);
    expect(events(mine)).toEqual([]);
    expect(mine.reviewer).toBeNull();
    // Nobody edits the document in review.
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/document`, headers: await t.as(users.drafter) })).json();
    for (const u of [users.drafter, users.reviewer]) {
      const saved = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}/document`, headers: { ...(await t.as(u)), 'if-match': `"${head.version}"` }, payload: { doc: head.doc, mode: 'limited' } });
      expect(saved.statusCode).toBe(403);
    }
  });

  it('request changes needs a message, sets the reviewer and opens a change request; resubmitting resolves it', async () => {
    const noMessage = await send(users.reviewer, 'REQUEST_CHANGES');
    expect(noMessage.statusCode).toBe(409);
    expect(noMessage.json().code).toBe('message_required');
    expect((await send(users.reviewer, 'REQUEST_CHANGES', { message: '   ' })).json().code).toBe('message_required');
    expect((await send(users.drafter, 'REQUEST_CHANGES', { message: 'x' })).json().code).toBe('not_allowed');
    const rc = await send(users.reviewer, 'REQUEST_CHANGES', { message: 'Fix the FTE table' });
    expect(rc.statusCode).toBe(201);
    expect(rc.json()).toMatchObject({ state: 'changes_requested', version: 2, seq: 2 });
    await drain();
    const w = await workflow(users.drafter);
    expect(w).toMatchObject({ state: 'changes_requested', reviewer: { userId: 'dev-reviewer', displayName: 'Rae Reviewer' }, editable: true });
    expect(w.changeRequest).toMatchObject({ message: 'Fix the FTE table', by: { userId: 'dev-reviewer', displayName: 'Rae Reviewer' } });
    expect(new Date(w.changeRequest.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(events(w)).toEqual(['SUBMIT']);
    expect(events(await workflow(users.reviewer))).toEqual([]);
    expect((await summary(users.drafter)).json()).toMatchObject({ state: 'changes_requested', reviewer: { userId: 'dev-reviewer' }, editable: true });
    // The drafter edits and resubmits with a reply.
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/document`, headers: await t.as(users.drafter) })).json();
    expect((await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': `"${head.version}"` }, payload: { doc: head.doc, mode: 'limited' } })).statusCode).toBe(200);
    const again = await send(users.drafter, 'SUBMIT', { message: 'FTE table corrected' });
    expect(again.json()).toMatchObject({ state: 'in_review', seq: 3 });
    await drain();
    expect((await workflow(users.drafter)).changeRequest).toBeNull();
    const rows = (await t.app.db.execute(sql`SELECT requested_by, summary, resolved_at, resolution FROM note_change_requests WHERE note_revision_id = ${noteId}`)).rows as any[];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ requested_by: 'dev-reviewer', summary: 'Fix the FTE table', resolution: 'FTE table corrected' });
    expect(rows[0].resolved_at).toBeTruthy();
    // The reviewer stays; another reviewer may still act.
    expect((await workflow(users.reviewer)).reviewer.userId).toBe('dev-reviewer');
    expect(events(await workflow(users.both))).toEqual(['REQUEST_CHANGES', 'APPROVE']);
  });

  it('approval freezes the head version; publication stamps the revision, emits note.published and opens it to viewers', async () => {
    expect((await send(users.drafter, 'APPROVE')).statusCode).toBe(409);
    expect((await send(users.reviewer, 'PUBLISH')).json().code).toBe('not_allowed');
    const approve = await send(users.reviewer, 'APPROVE', { message: 'Looks right' });
    expect(approve.json()).toMatchObject({ state: 'approved', seq: 4 });
    await drain();
    const s = (await summary(users.reviewer)).json();
    expect(s.state).toBe('approved');
    expect(s.approvedVersion).toBe(s.headVersion);
    expect(s.approvedVersion).toBe(2);
    expect(s.publishedAt).toBeNull();
    const versions = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/versions`, headers: await t.as(users.reviewer) })).json();
    expect(versions[0].label).toBe('Approved');
    expect(events(await workflow(users.reviewer))).toEqual(['PUBLISH']);
    expect(events(await workflow(users.drafter))).toEqual([]);
    expect((await summary(users.viewer)).statusCode).toBe(403);
    expect((await send(users.drafter, 'PUBLISH')).json().code).toBe('not_allowed');
    const publish = await send(users.reviewer, 'PUBLISH');
    expect(publish.json()).toMatchObject({ state: 'published', seq: 5 });
    await drain();
    const p = (await summary(users.viewer)).json();
    expect(p).toMatchObject({ state: 'published', publishedBy: { userId: 'dev-reviewer', displayName: 'Rae Reviewer' }, publishedVersion: 2, approvedVersion: 2, editable: false });
    expect(new Date(p.publishedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const w = await workflow(users.viewer);
    expect(w.state).toBe('published');
    expect(events(w)).toEqual([]);
    for (const u of [users.drafter, users.reviewer, users.both]) expect(events(await workflow(u))).toEqual([]);
    for (const e of ['SUBMIT', 'REQUEST_CHANGES', 'APPROVE', 'PUBLISH']) expect((await send(users.reviewer, e, { message: 'x' })).statusCode).toBe(409);
    const published = (await t.app.db.execute(sql`SELECT payload FROM outbox WHERE type = 'note.published' AND payload->>'noteRevisionId' = ${noteId}`)).rows as any[];
    expect(published.length).toBe(1);
    expect(published[0].payload).toMatchObject({ noteRevisionId: noteId, billKey: 'WA:2025-26:HB2402', versionCode: 'S', publishedVersion: 2, publishedBy: 'dev-reviewer' });
    const onBill = (await t.app.inject({ method: 'GET', url: '/api/v1/bills/2025-26/HB2402/notes', headers: await t.as(users.viewer) })).json();
    expect(onBill.map((n: any) => n.noteRevisionId)).toContain(noteId);
  });

  it('the transition history and the audit log are complete', async () => {
    const log = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/transitions`, headers: await t.as(users.drafter) })).json();
    expect(log.map((x: any) => x.event).reverse()).toEqual(['SUBMIT', 'REQUEST_CHANGES', 'SUBMIT', 'APPROVE', 'PUBLISH']);
    expect(log.map((x: any) => x.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(log.find((x: any) => x.event === 'REQUEST_CHANGES')).toMatchObject({ fromState: 'in_review', toState: 'changes_requested', actorId: 'dev-reviewer', actorName: 'Rae Reviewer', comment: 'Fix the FTE table' });
    expect(log.find((x: any) => x.seq === 3)).toMatchObject({ event: 'SUBMIT', fromState: 'changes_requested', toState: 'in_review', actorId: 'dev-drafter', comment: 'FTE table corrected' });
    expect(log.find((x: any) => x.event === 'PUBLISH')).toMatchObject({ fromState: 'approved', toState: 'published', comment: null });
    const audit = (await t.app.inject({ method: 'GET', url: `/api/v1/admin/audit?objectId=${noteId}`, headers: await t.as(users.admin) })).json();
    const actions = audit.map((a: any) => a.action);
    for (const a of ['note.create', 'workflow.instance_create', 'workflow.submit', 'workflow.request_changes', 'workflow.approve', 'workflow.publish', 'note.publish', 'permission.denied']) expect(actions).toContain(a);
    // A viewer sees the published note's history too.
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/transitions`, headers: await t.as(users.viewer) })).statusCode).toBe(200);
  });

  it('a drafter with the reviewer role cannot review their own note', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.both), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact' } });
    expect(res.statusCode).toBe(201);
    const id = res.json().noteRevisionId;
    expect(res.json().drafter.userId).toBe('dev-both');
    expect((await send(users.both, 'SUBMIT', {}, id)).statusCode).toBe(201);
    expect(events(await workflow(users.both, id))).toEqual([]);
    expect((await send(users.both, 'APPROVE', {}, id)).json().code).toBe('not_allowed');
    expect(events(await workflow(users.reviewer, id))).toEqual(['REQUEST_CHANGES', 'APPROVE']);
    expect((await send(users.reviewer, 'APPROVE', {}, id)).json().state).toBe('approved');
    expect((await workflow(users.both, id)).reviewer.userId).toBe('dev-reviewer');
    // The list shows both of Jordan's roles' notes; the viewer sees only the published one.
    const mine = (await t.app.inject({ method: 'GET', url: '/api/v1/notes?assignee=me', headers: await t.as(users.both) })).json();
    expect(mine.map((n: any) => n.noteRevisionId)).toContain(id);
    const theirs = (await t.app.inject({ method: 'GET', url: '/api/v1/notes', headers: await t.as(users.viewer) })).json();
    expect(theirs.map((n: any) => n.state)).toEqual(['published']);
  });
});
