import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { createTestApp, truncate, users, type TestContext } from './helpers.js';
import { DirectoryFetcher, ingestLegiscanBills, readDataset } from '../src/modules/bills/index.js';
import { seedTemplates } from '../src/modules/templates/index.js';
import { seedReference } from '../src/modules/reference/index.js';
import { seedUsers } from '../src/db/seed.js';
import { emitEvent } from '../src/lib/outbox.js';
import { MemoryMailer } from '../src/modules/notifications/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const LEGISCAN = join(here, 'fixtures', 'legiscan');
const XML_FIXTURES = join(here, '..', '..', '..', 'packages', 'bill-document', 'fixtures');

let t: TestContext;
let mailer: MemoryMailer;
let noteId: string;

const inbox = async (u: (typeof users)[keyof typeof users], unread = true) => (await t.app.inject({ method: 'GET', url: `/api/v1/notifications?unread=${unread}`, headers: await t.as(u) })).json() as any[];
const workflow = async (u: (typeof users)[keyof typeof users], id = noteId) => (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${id}/workflow`, headers: await t.as(u) })).json();
const send = async (u: (typeof users)[keyof typeof users], event: string, extra: Record<string, unknown> = {}, id = noteId) => t.app.inject({ method: 'POST', url: `/api/v1/notes/${id}/transitions`, headers: await t.as(u), payload: { event, ...extra } });
const drain = async () => {
  await t.app.bus.drain();
  await t.app.bus.drain();
};

beforeAll(async () => {
  mailer = new MemoryMailer();
  t = await createTestApp({ SEARCH_BACKEND: 'postgres' }, { mailer });
  await truncate(t.handle, ['bills', 'bill_versions', 'amendments', 'hearings', 'prior_fiscal_notes', 'outbox', 'outbox_consumptions', 'search_docs', 'notes', 'note_revisions', 'note_documents', 'note_comments', 'note_comment_messages', 'note_locks', 'templates', 'reference_sets', 'audit_log', 'workflow_instances', 'workflow_transitions', 'workflow_assignments', 'workflow_deadlines', 'notifications']);
  await seedUsers(t.app.db);
  await seedTemplates(t.app.db, t.config.TEMPLATES_DIR);
  await seedReference(t.app.db, t.config.REFERENCE_DIR);
  await ingestLegiscanBills({ db: t.app.db, fetcher: new DirectoryFetcher(XML_FIXTURES), log: t.app.log as unknown as Logger }, readDataset(LEGISCAN, { bills: ['HB2402', 'SB6137'] }), {});
  await drain();
});
afterAll(async () => {
  await t.close();
});

describe('workflow: the review cycle', () => {
  it('creating a note creates a todo instance with the drafter assigned and a statutory deadline', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'S', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter', request: { requestId: 'wf-1', requestedAt: '2026-02-05T18:00:00Z' } } });
    expect(res.statusCode).toBe(201);
    noteId = res.json().noteRevisionId;
    await drain();
    const w = await workflow(users.drafter);
    expect(w).toMatchObject({ state: 'todo', drafterId: 'dev-drafter', reviewerId: null, version: 0, editable: true, drafterStatus: 'to-do', reviewerStatus: 'unstarted' });
    expect(w.availableEvents.map((e: any) => e.type)).toEqual(['START']);
    expect(w.deadlines.map((d: any) => d.kind)).toEqual(['statutory_72h']);
    expect(w.deadlines[0].dueAt).toBe('2026-02-08T18:00:00.000Z');
    // The note summary now reads state from the workflow.
    const s = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}`, headers: await t.as(users.reviewer) })).json();
    expect(s.state).toBe('todo');
    expect(s.effectiveDueAt).toBe('2026-02-08T18:00:00.000Z');
    // The drafter was told.
    const mail = await inbox(users.drafter);
    expect(mail.some((n) => n.type === 'note.assigned')).toBe(true);
    expect(mailer.sent.some((m) => /dana/i.test(m.to) && /assigned/.test(m.subject))).toBe(true);
    // A viewer cannot see the workflow.
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/workflow`, headers: await t.as(users.viewer) })).statusCode).toBe(403);
  });

  it("the drafter's first save starts the task; submitting needs the drafter", async () => {
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/document`, headers: await t.as(users.drafter) })).json();
    const saved = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc: head.doc, mode: 'limited' } });
    expect(saved.statusCode).toBe(200);
    await drain();
    expect((await workflow(users.drafter)).state).toBe('in_progress');
    // Someone else cannot submit.
    const wrong = await send(users.reviewer, 'SUBMIT_FOR_REVIEW');
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().details.allowed).not.toContain('SUBMIT_FOR_REVIEW');
    // Stale version.
    const stale = await send(users.drafter, 'SUBMIT_FOR_REVIEW', { expectedVersion: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('version_mismatch');
    const ok = await send(users.drafter, 'SUBMIT_FOR_REVIEW', { comment: 'Ready', expectedVersion: 1 });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ state: 'review.pending', version: 2, seq: 2 });
    await drain();
    const w = await workflow(users.reviewer);
    expect(w.availableEvents.map((e: any) => e.type)).toContain('CLAIM_REVIEW');
    expect((await workflow(users.drafter)).editable).toBe(false);
    // Editors were notified; the drafter was not.
    expect((await inbox(users.reviewer)).some((n) => n.type === 'note.submitted')).toBe(true);
    expect((await inbox(users.both)).some((n) => n.type === 'note.submitted')).toBe(true);
    expect((await inbox(users.drafter)).some((n) => n.type === 'note.submitted')).toBe(false);
    // The pool row shows on the reviewer's queue in the reviewer vocabulary.
    const queue = (await t.app.inject({ method: 'GET', url: '/api/v1/assignments?role=reviewer', headers: await t.as(users.reviewer) })).json();
    const row = queue.find((r: any) => r.noteRevisionId === noteId);
    expect(row).toMatchObject({ pool: true, status: 'pending', state: 'review.pending', versionLabel: 'SHB 2402' });
  });

  it('the reviewer claims, requests changes (comment required), the drafter resubmits', async () => {
    const claim = await send(users.reviewer, 'CLAIM_REVIEW');
    expect(claim.statusCode).toBe(201);
    expect(claim.json().state).toBe('review.active');
    await drain();
    const w = await workflow(users.reviewer);
    expect(w.reviewerId).toBe('dev-reviewer');
    expect(w.editable).toBe(true); // REVIEWER_EDIT
    // A second reviewer cannot act now.
    expect((await send(users.both, 'REQUEST_CHANGES', { comment: 'x' })).statusCode).toBe(409);
    const noComment = await send(users.reviewer, 'REQUEST_CHANGES');
    expect(noComment.statusCode).toBe(409);
    expect(noComment.json().code).toBe('comment_required');
    const rc = await send(users.reviewer, 'REQUEST_CHANGES', { comment: 'Fix the FTE table' });
    expect(rc.json().state).toBe('changes_requested');
    await drain();
    expect((await inbox(users.drafter)).some((n) => n.type === 'note.changes_requested' && /Fix the FTE table/.test(n.body))).toBe(true);
    const mine = (await t.app.inject({ method: 'GET', url: '/api/v1/assignments?role=drafter', headers: await t.as(users.drafter) })).json();
    expect(mine.find((r: any) => r.noteRevisionId === noteId).status).toBe('address-review');
    const again = await send(users.drafter, 'SUBMIT_FOR_REVIEW');
    expect(again.json().state).toBe('review.pending');
    await drain();
    // The assigned reviewer keeps the review and is the one notified.
    expect((await workflow(users.reviewer)).reviewerId).toBe('dev-reviewer');
    expect((await inbox(users.reviewer)).filter((n) => n.type === 'note.submitted').length).toBe(2);
    expect((await inbox(users.both)).filter((n) => n.type === 'note.submitted').length).toBe(1);
  });

  it('a two-step Executive Review chain notifies each step, then approves', async () => {
    const chain = await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}/exec-chain`, headers: await t.as(users.reviewer), payload: { chain: [{ userId: 'dev-approver', division: 'RFA' }, { userId: 'dev-exec-budget', division: 'Budget' }] } });
    expect(chain.statusCode).toBe(200);
    expect((await send(users.reviewer, 'CLAIM_REVIEW')).json().state).toBe('review.active');
    const approve = await send(users.reviewer, 'APPROVE', { comment: 'Looks right' });
    expect(approve.json().state).toBe('exec_review.pending');
    await drain();
    expect((await inbox(users.approver)).some((n) => n.type === 'note.exec_review' && /step 1 of 2/.test(n.title))).toBe(true);
    expect((await inbox(users.execBudget)).some((n) => n.type === 'note.exec_review')).toBe(false);
    // Only the current exec may act.
    expect((await send(users.execBudget, 'EXEC_CLAIM')).statusCode).toBe(409);
    expect((await send(users.approver, 'EXEC_CLAIM')).json().state).toBe('exec_review.active');
    expect((await workflow(users.approver)).editable).toBe(true);
    const step1 = await send(users.approver, 'EXEC_DONE', { comment: 'RFA ok' });
    expect(step1.json().state).toBe('exec_review.pending');
    await drain();
    expect((await inbox(users.execBudget)).some((n) => n.type === 'note.exec_review' && /step 2 of 2/.test(n.title))).toBe(true);
    const w = await workflow(users.execBudget);
    expect(w.execIndex).toBe(1);
    expect(w.execChain[0].doneAt).toBeTruthy();
    expect(w.availableEvents.map((e: any) => e.type)).toContain('EXEC_CLAIM');
    expect(w.availableEvents.map((e: any) => e.type)).not.toContain('EXEC_DONE');
    expect((await send(users.execBudget, 'EXEC_CLAIM')).json().state).toBe('exec_review.active');
    const done = await send(users.execBudget, 'EXEC_DONE');
    expect(done.json().state).toBe('approved');
    await drain();
    // Final state: nothing more is available, the drafter and reviewer were told, the note reports approved.
    expect((await workflow(users.reviewer)).availableEvents).toEqual([]);
    expect((await inbox(users.drafter)).some((n) => n.type === 'note.approved')).toBe(true);
    expect((await inbox(users.reviewer)).some((n) => n.type === 'note.approved')).toBe(true);
    const s = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}`, headers: await t.as(users.viewer) })).json();
    expect(s.state).toBe('approved');
    const approvedEvents = (await t.app.db.execute(sql`SELECT count(*)::int AS n FROM outbox WHERE type = 'note.approved' AND payload->>'noteRevisionId' = ${noteId}`)).rows[0] as any;
    expect(Number(approvedEvents.n)).toBe(1);
    // Assignments are closed.
    const active = (await t.app.db.execute(sql`SELECT count(*)::int AS n FROM workflow_assignments a JOIN workflow_instances i ON i.id = a.instance_id WHERE i.note_revision_id = ${noteId} AND a.status = 'active'`)).rows[0] as any;
    expect(Number(active.n)).toBe(0);
  });

  it('the transition log is complete and audited', async () => {
    const log = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${noteId}/transitions`, headers: await t.as(users.drafter) })).json();
    expect(log.map((x: any) => x.event).reverse()).toEqual(['START', 'SUBMIT_FOR_REVIEW', 'CLAIM_REVIEW', 'REQUEST_CHANGES', 'SUBMIT_FOR_REVIEW', 'SET_EXEC_CHAIN', 'CLAIM_REVIEW', 'APPROVE', 'EXEC_CLAIM', 'EXEC_DONE', 'EXEC_CLAIM', 'EXEC_DONE']);
    expect(log.find((x: any) => x.event === 'REQUEST_CHANGES')).toMatchObject({ fromState: 'review.active', toState: 'changes_requested', actorId: 'dev-reviewer', actorName: 'Rae Reviewer', comment: 'Fix the FTE table' });
    expect(log.map((x: any) => x.seq)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const audit = (await t.app.inject({ method: 'GET', url: `/api/v1/admin/audit?objectId=${noteId}`, headers: await t.as(users.admin) })).json();
    const actions = audit.map((a: any) => a.action);
    for (const a of ['workflow.instance_create', 'workflow.start', 'workflow.submit_for_review', 'workflow.claim_review', 'workflow.request_changes', 'workflow.set_exec_chain', 'workflow.approve', 'workflow.exec_claim', 'workflow.exec_done']) expect(actions).toContain(a);
    // The inbox can be read and marked.
    const unread = await inbox(users.drafter);
    expect(unread.length).toBeGreaterThan(0);
    expect((await t.app.inject({ method: 'POST', url: `/api/v1/notifications/${unread[0].id}/read`, headers: await t.as(users.drafter) })).statusCode).toBe(204);
    expect((await inbox(users.drafter)).length).toBe(unread.length - 1);
    const count = (await t.app.inject({ method: 'GET', url: '/api/v1/notifications/unread-count', headers: await t.as(users.drafter) })).json();
    expect(count.unread).toBe(unread.length - 1);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers: await t.as(users.drafter) })).json().marked).toBe(unread.length - 1);
  });
});

describe('workflow: deadlines, dashboards, assignment, supersession', () => {
  let urgentId: string;
  let calmId: string;

  it('a hearing four hours away puts the note at the top of the queue with an overdue label', async () => {
    const calm = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:HB2402', versionCode: 'I', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter', request: { requestId: 'wf-calm' } } });
    calmId = calm.json().noteRevisionId;
    const urgent = await t.app.inject({ method: 'POST', url: '/api/v1/notes', headers: await t.as(users.reviewer), payload: { billKey: 'WA:2025-26:SB6137', versionCode: 'I', templateId: 'no-fiscal-impact', drafterId: 'dev-drafter', request: { requestId: 'wf-urgent' }, priority: 'high' } });
    urgentId = urgent.json().noteRevisionId;
    await drain();
    // The bills module announces a hearing in four hours (payload as ingest emits it).
    const hearingAt = new Date(Date.now() + 4 * 3_600_000).toISOString();
    await emitEvent(t.app.db, 'hearing.scheduled', { billKey: 'WA:2025-26:SB6137', versionCode: 'I', hearingAt, committee: 'Ways & Means', chamber: 'S', kind: 'public_hearing', hearingId: 'test-hearing' });
    // The workflow reads hearings from the bills API; give it one.
    await t.app.db.execute(sql`INSERT INTO hearings (id, bill_key, committee, chamber, hearing_at, kind) VALUES ('test-hearing', 'WA:2025-26:SB6137', 'Ways & Means', 'S', ${hearingAt}::timestamptz, 'public_hearing')`);
    t.app.bus.kick();
    await drain();
    const w = await workflow(users.drafter, urgentId);
    const hearingDeadline = w.deadlines.find((d: any) => d.kind === 'hearing_minus_4h');
    expect(hearingDeadline).toBeTruthy();
    expect(new Date(hearingDeadline.dueAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // The poller breaches it now and warns the assignee and the managers.
    const polled = (await t.app.inject({ method: 'POST', url: '/api/v1/workflow/poll-deadlines', headers: await t.as(users.admin) })).json();
    expect(polled.overdue).toBeGreaterThanOrEqual(1);
    await drain();
    const drafterInbox = await inbox(users.drafter);
    expect(drafterInbox.some((n) => n.type === 'note.overdue' && n.link === `/notes/${urgentId}`)).toBe(true);
    expect((await inbox(users.manager)).some((n) => n.type === 'note.overdue')).toBe(true);
    // The hearing notification also reached the drafter (bill change alert).
    expect(drafterInbox.some((n) => n.type === 'hearing.scheduled')).toBe(true);
    // Queue order: the urgent note first, labelled overdue; the calm one later with the 72-hour band.
    const queue = (await t.app.inject({ method: 'GET', url: '/api/v1/assignments?role=drafter', headers: await t.as(users.drafter) })).json();
    const ids = queue.map((r: any) => r.noteRevisionId);
    expect(ids[0]).toBe(urgentId);
    expect(queue[0]).toMatchObject({ band: 'overdue', status: 'to-do', priority: 'high' });
    expect(queue[0].nextHearingAt).toBe(hearingAt);
    expect(ids.indexOf(calmId)).toBeGreaterThan(0);
    expect(queue.find((r: any) => r.noteRevisionId === calmId).band).toBe('more_than_24h');
    // Summary counts by state.
    const summary = (await t.app.inject({ method: 'GET', url: '/api/v1/workflow/summary', headers: await t.as(users.reviewer) })).json();
    expect(summary.todo).toBe(2);
    expect(summary.approved).toBe(1);
    // Cancelling the hearing removes the deadline.
    await t.app.db.execute(sql`UPDATE hearings SET cancelled = true WHERE id = 'test-hearing'`);
    await emitEvent(t.app.db, 'hearing.cancelled', { billKey: 'WA:2025-26:SB6137', hearingId: 'test-hearing', hearingAt });
    t.app.bus.kick();
    await drain();
    expect((await workflow(users.drafter, urgentId)).deadlines.map((d: any) => d.kind)).toEqual(['statutory_72h']);
  });

  it('assignment and reassignment by an assigner, with a role due date', async () => {
    const due = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const denied = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${calmId}/assign`, headers: await t.as(users.drafter2), payload: { role: 'drafter', userId: 'dev-template-editor' } });
    expect(denied.statusCode).toBe(403);
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${calmId}/assign`, headers: await t.as(users.manager), payload: { role: 'drafter', userId: 'dev-template-editor', dueAt: due } });
    expect(res.statusCode).toBe(200);
    await drain();
    const w = await workflow(users.manager, calmId);
    expect(w.drafterId).toBe('dev-template-editor');
    expect(w.deadlines.map((d: any) => d.kind).sort()).toEqual(['role_due', 'statutory_72h']);
    expect((await inbox(users.templateEditor)).some((n) => n.type === 'note.assigned')).toBe(true);
    expect((await inbox(users.drafter)).some((n) => n.type === 'note.reassigned')).toBe(true);
    // The old drafter lost edit rights and the row moved queues.
    expect((await workflow(users.drafter, calmId)).editable).toBe(false);
    const mine = (await t.app.inject({ method: 'GET', url: '/api/v1/assignments?role=drafter', headers: await t.as(users.drafter) })).json();
    expect(mine.map((r: any) => r.noteRevisionId)).not.toContain(calmId);
    const theirs = (await t.app.inject({ method: 'GET', url: '/api/v1/assignments?role=drafter', headers: await t.as(users.templateEditor) })).json();
    expect(theirs.find((r: any) => r.noteRevisionId === calmId).dueAt).toBe(new Date(due).toISOString());
    // Assigners see everyone's rows.
    const all = (await t.app.inject({ method: 'GET', url: '/api/v1/assignments?all=true', headers: await t.as(users.manager) })).json();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/assignments?assignee=dev-template-editor', headers: await t.as(users.drafter) })).statusCode).toBe(403);
  });

  it('a new bill version supersedes the open revision and offers a cloned revision', async () => {
    // The bills module announces a new version: the drafter is told and offered a revision.
    await emitEvent(t.app.db, 'bill.version_added', { billKey: 'WA:2025-26:SB6137', versionCode: 'S', label: 'SSB 6137', sourceHash: null });
    t.app.bus.kick();
    await drain();
    const alert = (await inbox(users.drafter)).find((n) => n.type === 'bill.version_added');
    expect(alert).toBeTruthy();
    expect(alert.link).toBe(`/notes/${urgentId}`);
    // The drafter starts working, then creates the revision for the new version.
    const head = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${urgentId}/document`, headers: await t.as(users.drafter) })).json();
    await t.app.inject({ method: 'PUT', url: `/api/v1/notes/${urgentId}/document`, headers: { ...(await t.as(users.drafter)), 'if-match': '"1"' }, payload: { doc: head.doc, mode: 'limited' } });
    await drain();
    expect((await workflow(users.drafter, urgentId)).state).toBe('in_progress');
    const rev = await t.app.inject({ method: 'POST', url: `/api/v1/notes/${urgentId}/revisions`, headers: await t.as(users.drafter), payload: { versionCode: 'S' } });
    expect(rev.statusCode).toBe(201);
    const newId = rev.json().noteRevisionId;
    await drain();
    const old = await workflow(users.drafter, urgentId);
    expect(old.state).toBe('superseded');
    expect(old.supersededBy).toBe(newId);
    expect(old.availableEvents).toEqual([]);
    const fresh = await workflow(users.drafter, newId);
    expect(fresh).toMatchObject({ state: 'todo', drafterId: 'dev-drafter', duplicatedFrom: urgentId });
    expect(fresh.deadlines.map((d: any) => d.kind)).toEqual(['statutory_72h']);
    expect((await inbox(users.drafter)).some((n) => n.type === 'note.superseded')).toBe(true);
    const log = (await t.app.inject({ method: 'GET', url: `/api/v1/notes/${urgentId}/transitions`, headers: await t.as(users.drafter) })).json();
    expect(log[0]).toMatchObject({ event: 'SUPERSEDE', actorId: 'system', toState: 'superseded' });
    // The superseded revision drops off the drafter queue; the new one is on it.
    const mine = (await t.app.inject({ method: 'GET', url: '/api/v1/assignments?role=drafter', headers: await t.as(users.drafter) })).json();
    expect(mine.map((r: any) => r.noteRevisionId)).toContain(newId);
    expect(mine.map((r: any) => r.noteRevisionId)).not.toContain(urgentId);
  });

  it('lists bills with hearings inside the window that have no note', async () => {
    await t.app.db.execute(sql`INSERT INTO hearings (id, bill_key, committee, chamber, hearing_at, kind) VALUES ('h-2402', 'WA:2025-26:HB2402', 'Finance', 'H', ${new Date(Date.now() + 30 * 3_600_000).toISOString()}::timestamptz, 'public_hearing')`);
    await t.app.db.execute(sql`INSERT INTO bills (bill_key, biennium, chamber, type, number, id, title, legiscan_bill_id, change_hash)
      SELECT 'WA:2025-26:HB9999', biennium, chamber, type, 9999, 'HB9999', 'A bill with a hearing and no note', 999999, 'x' FROM bills WHERE bill_key = 'WA:2025-26:HB2402'`);
    await t.app.db.execute(sql`INSERT INTO hearings (id, bill_key, committee, chamber, hearing_at, kind) VALUES ('h-9999', 'WA:2025-26:HB9999', 'Finance', 'H', ${new Date(Date.now() + 20 * 3_600_000).toISOString()}::timestamptz, 'public_hearing')`);
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/workflow/unassigned-hearings?withinHours=72', headers: await t.as(users.reviewer) });
    expect(res.statusCode).toBe(200);
    const keys = res.json().map((h: any) => h.billKey);
    expect(keys).toContain('WA:2025-26:HB9999');
    expect(keys).not.toContain('WA:2025-26:HB2402');
    expect(res.json().find((h: any) => h.billKey === 'WA:2025-26:HB9999').title).toMatch(/no note/);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/workflow/unassigned-hearings', headers: await t.as(users.drafter) })).statusCode).toBe(403);
  });

  it('a manager can cancel; nothing is allowed afterwards', async () => {
    const res = await send(users.manager, 'CANCEL', { comment: 'Bill died in committee' }, calmId);
    expect(res.statusCode).toBe(201);
    expect(res.json().state).toBe('cancelled');
    expect((await send(users.templateEditor, 'START', {}, calmId)).statusCode).toBe(409);
    await drain();
    expect((await inbox(users.templateEditor)).some((n) => n.type === 'note.cancelled')).toBe(true);
  });
});
