// Notes module: notes, revisions, documents (autosave heads), comments.
import type { ExportService } from './export/service.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { label as shortLabel, type BillType } from '@wa-leg/billref';
import { docToHtml, docToText, extractEstimateData, loadTemplate, recompute, validateNote, type EstimateData, type PMNode, type ValidationResult } from '@wa-leg/note-schema';
import { isEditable, type WorkflowState } from '@wa-leg/workflow-machine';
import type { Db, DbOrTx } from '../../db/client.js';
import { badRequest, forbidden, notFound, preconditionFailed } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/outbox.js';
import { can, hasRole, type NoteResource, type Principal } from '../identity/index.js';
import { buildTemplateContext, fetchBillFacts } from './context.js';
import { readNoteState, type NoteState } from './state.js';

export interface UserRef {
  userId: string;
  displayName?: string;
}

export interface NoteRevisionSummary {
  noteRevisionId: string;
  noteId: string;
  billKey: string;
  biennium: string;
  billId: string;
  billTitle?: string;
  versionCode: string;
  versionLabel: string;
  state: WorkflowState;
  drafter: UserRef | null;
  reviewer: UserRef | null;
  headVersion: number;
  approvedVersion: number | null;
  publishedAt: string | null;
  publishedBy: UserRef | null;
  publishedVersion: number | null;
  templateId: string | null;
  templateVersion: number | null;
  mode: 'limited' | 'full';
  /** The state allows the drafter to edit. */
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDocument {
  noteId: string;
  version: number;
  mode: 'limited' | 'full';
  doc: PMNode;
  templateId?: string | null;
  templateVersion?: number | null;
  label?: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface CreateNoteInput {
  billKey: string;
  versionCode: string;
  templateId: string;
  /** Reviewers name the drafter; a drafter creates for themselves. */
  drafterId?: string;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

export class NotesService {
  /** Export renderer, attached by createNotes(). */
  exports!: ExportService;

  constructor(
    private readonly app: FastifyInstance,
    private readonly db: Db,
  ) {}

  // ---------- rows ----------

  private async revisionRow(noteRevisionId: string): Promise<any> {
    const r = (await this.db.execute(sql`SELECT r.*, n.bill_key, n.created_by AS note_created_by
      FROM note_revisions r JOIN notes n ON n.note_id = r.note_id WHERE r.note_revision_id = ${noteRevisionId}`)).rows[0];
    if (!r) throw notFound('Note revision');
    return r;
  }

  private readonly userCache = new Map<string, { at: number; name?: string }>();

  private async userName(userId: string | null): Promise<string | undefined> {
    if (!userId) return undefined;
    const hit = this.userCache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.name;
    const r = (await this.db.execute(sql`SELECT display_name FROM users WHERE user_id = ${userId}`)).rows[0] as { display_name: string } | undefined;
    const entry = { at: Date.now(), name: r?.display_name ?? undefined };
    this.userCache.set(userId, entry);
    return entry.name;
  }

  private async userRef(userId: string | null): Promise<UserRef | null> {
    return userId ? { userId, displayName: await this.userName(userId) } : null;
  }

  /** Resource for `can()` from a revision row and its workflow state. */
  async resource(noteRevisionId: string): Promise<{ row: any; state: NoteState; res: NoteResource }> {
    const row = await this.revisionRow(noteRevisionId);
    const state = await readNoteState(this.app, noteRevisionId, row.drafter_id ?? null);
    const participants = ((await this.db.execute(sql`SELECT DISTINCT created_by AS u FROM note_comments WHERE note_revision_id = ${noteRevisionId}
        UNION SELECT DISTINCT author_id FROM note_comment_messages m JOIN note_comments c ON c.id = m.comment_id WHERE c.note_revision_id = ${noteRevisionId}`)).rows as any[]).map((r) => r.u as string);
    const res: NoteResource = {
      type: 'note',
      state: state.state,
      drafterId: state.drafterId,
      reviewerId: state.reviewerId,
      participantIds: [...participants, row.note_created_by, row.created_by].filter(Boolean),
    };
    return { row, state, res };
  }

  async assertCan(p: Principal, action: Parameters<typeof can>[1], noteRevisionId: string, requestId?: string): Promise<{ row: any; state: NoteState; res: NoteResource }> {
    const ctx = await this.resource(noteRevisionId);
    if (!can(p, action, ctx.res)) {
      await writeAudit(this.db, { actorId: p.userId, action: 'permission.denied', objectType: 'note_revision', objectId: noteRevisionId, after: { action }, requestId: requestId ?? null });
      throw forbidden(`Not allowed: ${action}`);
    }
    return ctx;
  }

  async billFacts(billKey: string, p?: Principal) {
    return fetchBillFacts(this.app, billKey, p);
  }

  async summary(noteRevisionId: string, ctx?: { row: any; state: NoteState }): Promise<NoteRevisionSummary> {
    const { row, state } = ctx ?? (await this.resource(noteRevisionId));
    const [, biennium, billId] = String(row.bill_key).split(':');
    const type = (billId ?? 'HB0').replace(/\d+$/, '') as BillType;
    const number = Number((billId ?? '').replace(/^[A-Z]+/, ''));
    const facts = await fetchBillFacts(this.app, row.bill_key);
    const versionLabel = facts?.versions.find((v) => v.code === row.version_code)?.shortLabel ?? shortLabel({ type, number, versionCode: row.version_code });
    return {
      noteRevisionId,
      noteId: row.note_id,
      billKey: row.bill_key,
      biennium: biennium ?? '',
      billId: billId ?? '',
      billTitle: facts?.title,
      versionCode: row.version_code,
      versionLabel,
      state: state.state,
      drafter: await this.userRef(state.drafterId),
      reviewer: await this.userRef(state.reviewerId),
      headVersion: row.head_version,
      approvedVersion: row.approved_document_version ?? null,
      publishedAt: row.published_at ? iso(row.published_at) : null,
      publishedBy: await this.userRef(row.published_by ?? null),
      publishedVersion: row.published_version ?? null,
      templateId: row.template_id ?? null,
      templateVersion: row.template_version ?? null,
      mode: row.mode,
      editable: isEditable(state.state),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  // ---------- create ----------

  /** Create a note and its first revision in `draft` with a drafter, from a template. */
  async create(p: Principal, input: CreateNoteInput, requestId: string): Promise<NoteRevisionSummary> {
    if (!can(p, 'note.create', { type: 'note.create', drafterId: input.drafterId ?? null })) {
      await writeAudit(this.db, { actorId: p.userId, action: 'permission.denied', objectType: 'note', objectId: input.billKey, after: { action: 'note.create' }, requestId });
      throw forbidden('Not allowed: note.create');
    }
    const drafterId = input.drafterId ?? (hasRole(p, 'drafter') ? p.userId : null);
    if (!drafterId) throw badRequest('drafter_required', 'Name the drafter (drafterId)');
    const drafterRow = (await this.db.execute(sql`SELECT roles FROM users WHERE user_id = ${drafterId}`)).rows[0] as { roles: string[] } | undefined;
    if (!drafterRow?.roles.includes('drafter')) throw badRequest('unknown_drafter', `${drafterId} is not a drafter`);
    const facts = await fetchBillFacts(this.app, input.billKey, p);
    if (!facts) throw notFound(`Bill ${input.billKey}`);
    if (!facts.versions.some((v) => v.code === input.versionCode)) throw badRequest('unknown_version', `Version ${input.versionCode} of ${facts.id} is not loaded`);
    const noteId = randomUUID();
    const noteRevisionId = randomUUID();

    const t = await this.app.templates.get(input.templateId);
    const ctx = await buildTemplateContext(this.app, { billKey: input.billKey, versionCode: input.versionCode, noteRevisionId }, p);
    const jobs = (await this.app.reference.get('job-classes')) as { classes: { title: string; salary: number }[] };
    ctx.fteClass = jobs.classes.slice(0, 12).map((c) => ({ title: c.title, salary: c.salary.toLocaleString('en-US') }));
    const doc = loadTemplate(t.html, ctx, { mode: t.mode }).doc;

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO notes (note_id, bill_key, created_by) VALUES (${noteId}, ${input.billKey}, ${p.userId})`);
      await tx.execute(sql`INSERT INTO note_revisions (note_revision_id, note_id, version_code, drafter_id, template_id, template_version, mode, head_version, created_by)
        VALUES (${noteRevisionId}, ${noteId}, ${input.versionCode}, ${drafterId}, ${t.id}, ${t.version}, 'limited', 1, ${p.userId})`);
      await this.storeDocument(tx, noteRevisionId, 1, doc, 'limited', p.userId, { label: `Template ${t.id}` });
      await this.app.workflowSvc.createInstance({ noteRevisionId, billKey: input.billKey, versionCode: input.versionCode, drafterId }, p.userId, requestId, tx);
      await writeAudit(tx, { actorId: p.userId, action: 'note.create', objectType: 'note_revision', objectId: noteRevisionId, after: { noteId, billKey: input.billKey, versionCode: input.versionCode, templateId: t.id, drafterId }, requestId });
      await emitEvent(tx, 'note.created', { noteId, noteRevisionId, billKey: input.billKey, versionCode: input.versionCode, drafterId });
    });
    this.app.bus.kick();
    return this.summary(noteRevisionId);
  }

  // ---------- documents ----------

  private async storeDocument(tx: DbOrTx, noteRevisionId: string, version: number, doc: PMNode, mode: 'limited' | 'full', actor: string, opts: { label?: string | null; clientId?: string | null; summary?: string | null } = {}): Promise<{ estimate: EstimateData; validation: ValidationResult }> {
    const computed = recompute(doc).doc;
    const html = docToHtml(computed, { mode });
    const text = docToText(computed);
    const estimate = extractEstimateData(computed);
    const validation = validateNote(computed);
    await tx.execute(sql`INSERT INTO note_documents (note_revision_id, version, mode, doc_json, doc_html, doc_text, estimate_data, validation, label, summary, client_id, updated_by)
      VALUES (${noteRevisionId}, ${version}, ${mode}, ${JSON.stringify(computed)}::jsonb, ${html}, ${text}, ${JSON.stringify(estimate)}::jsonb, ${JSON.stringify(validation)}::jsonb,
        ${opts.label ?? null}, ${opts.summary ?? null}, ${opts.clientId ?? null}, ${actor})`);
    await tx.execute(sql`UPDATE note_revisions SET head_version = ${version}, mode = ${mode}, updated_at = now() WHERE note_revision_id = ${noteRevisionId}`);
    return { estimate, validation };
  }

  async getDocument(noteRevisionId: string, version?: number): Promise<NoteDocument> {
    const row = await this.revisionRow(noteRevisionId);
    const v = version ?? row.head_version;
    const d = (await this.db.execute(sql`SELECT * FROM note_documents WHERE note_revision_id = ${noteRevisionId} AND version = ${v}`)).rows[0] as any;
    if (!d) throw notFound(`Document version ${v}`);
    return { noteId: noteRevisionId, version: d.version, mode: d.mode, doc: d.doc_json, templateId: row.template_id ?? null, templateVersion: row.template_version ?? null, label: d.label ?? null, updatedAt: iso(d.updated_at), updatedBy: d.updated_by };
  }

  async saveDocument(p: Principal, noteRevisionId: string, ifMatch: string, body: { doc: PMNode; mode: 'limited' | 'full'; clientId?: string }, requestId: string): Promise<{ version: number; savedAt: string; estimateData: EstimateData; validation: ValidationResult }> {
    await this.assertCan(p, 'note.edit', noteRevisionId, requestId);
    const expected = Number(ifMatch.replace(/^W\//, '').replace(/"/g, ''));
    if (!Number.isFinite(expected)) throw badRequest('bad_if_match', 'If-Match must carry the current document version');
    return this.db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`SELECT head_version FROM note_revisions WHERE note_revision_id = ${noteRevisionId} FOR UPDATE`)).rows[0] as any;
      const head = Number(locked.head_version);
      if (head !== expected) {
        const current = (await tx.execute(sql`SELECT version, doc_json, updated_by, updated_at FROM note_documents WHERE note_revision_id = ${noteRevisionId} AND version = ${head}`)).rows[0] as any;
        throw preconditionFailed({ version: head, doc: current?.doc_json, updatedBy: current?.updated_by, updatedByName: await this.userName(current?.updated_by ?? null), updatedAt: current ? iso(current.updated_at) : null });
      }
      const next = head + 1;
      const { estimate, validation } = await this.storeDocument(tx, noteRevisionId, next, body.doc, body.mode, p.userId, { clientId: body.clientId ?? null });
      await writeAudit(tx, { actorId: p.userId, action: 'note.document_save', objectType: 'note_revision', objectId: noteRevisionId, before: { version: head }, after: { version: next }, requestId });
      await emitEvent(tx, 'note.document_saved', { noteRevisionId, version: next, actorId: p.userId });
      return { version: next, savedAt: new Date().toISOString(), estimateData: estimate, validation };
    });
  }

  async listVersions(noteRevisionId: string) {
    const rows = (await this.db.execute(sql`SELECT version, label, summary, updated_by, updated_at, validation FROM note_documents WHERE note_revision_id = ${noteRevisionId} ORDER BY version DESC`)).rows as any[];
    const names = new Map<string, string | undefined>();
    for (const r of rows) if (!names.has(r.updated_by)) names.set(r.updated_by, await this.userName(r.updated_by));
    return rows.map((r) => ({ version: r.version, label: r.label ?? null, createdBy: r.updated_by, createdByName: names.get(r.updated_by) ?? null, createdAt: iso(r.updated_at), summary: r.summary ?? (r.validation?.ok === false ? `${r.validation.errors.length} validation error(s)` : null) }));
  }

  // ---------- comments ----------

  async listComments(noteRevisionId: string) {
    const threads = (await this.db.execute(sql`SELECT * FROM note_comments WHERE note_revision_id = ${noteRevisionId} ORDER BY created_at`)).rows as any[];
    const messages = (await this.db.execute(sql`SELECT m.* FROM note_comment_messages m JOIN note_comments c ON c.id = m.comment_id WHERE c.note_revision_id = ${noteRevisionId} ORDER BY m.created_at`)).rows as any[];
    const head = await this.getDocument(noteRevisionId).catch(() => null);
    const present = new Map<string, number>();
    if (head) {
      let pos = 0;
      const walk = (n: any) => {
        if (n.marks) for (const m of n.marks) if (m.type === 'comment' && m.attrs?.commentId && !present.has(m.attrs.commentId)) present.set(m.attrs.commentId, pos);
        if (n.text) pos += n.text.length;
        else pos += 1;
        for (const c of n.content ?? []) walk(c);
      };
      walk(head.doc);
    }
    const names = new Map<string, string | undefined>();
    const nameOf = async (u: string) => {
      if (!names.has(u)) names.set(u, await this.userName(u));
      return names.get(u);
    };
    const out = [];
    for (const t of threads) {
      const msgs = [];
      for (const m of messages.filter((m) => m.comment_id === t.id)) msgs.push({ id: m.id, authorId: m.author_id, authorName: (await nameOf(m.author_id)) ?? m.author_id, body: m.body, createdAt: iso(m.created_at) });
      out.push({ id: t.id, status: t.status, anchorText: t.anchor_text, detached: !present.has(t.id), position: present.get(t.id) ?? null, createdBy: t.created_by, createdAt: iso(t.created_at), messages: msgs });
    }
    return out.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  }

  async createComment(p: Principal, noteRevisionId: string, input: { anchorText: string; body: string; id?: string }, requestId: string): Promise<{ id: string }> {
    await this.assertCan(p, 'note.comment', noteRevisionId, requestId);
    const id = input.id ?? `c_${randomUUID()}`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO note_comments (id, note_revision_id, anchor_text, status, created_by) VALUES (${id}, ${noteRevisionId}, ${input.anchorText}, 'open', ${p.userId})`);
      await tx.execute(sql`INSERT INTO note_comment_messages (id, comment_id, author_id, body) VALUES (${`m_${randomUUID()}`}, ${id}, ${p.userId}, ${input.body})`);
      await writeAudit(tx, { actorId: p.userId, action: 'note.comment_create', objectType: 'note_revision', objectId: noteRevisionId, after: { commentId: id }, requestId });
    });
    return { id };
  }

  async reply(p: Principal, noteRevisionId: string, commentId: string, body: string, requestId: string): Promise<{ id: string }> {
    await this.assertCan(p, 'note.comment', noteRevisionId, requestId);
    const id = `m_${randomUUID()}`;
    await this.db.transaction(async (tx) => {
      const exists = (await tx.execute(sql`SELECT 1 FROM note_comments WHERE id = ${commentId} AND note_revision_id = ${noteRevisionId}`)).rows[0];
      if (!exists) throw notFound('Comment thread');
      await tx.execute(sql`INSERT INTO note_comment_messages (id, comment_id, author_id, body) VALUES (${id}, ${commentId}, ${p.userId}, ${body})`);
      await writeAudit(tx, { actorId: p.userId, action: 'note.comment_reply', objectType: 'note_revision', objectId: noteRevisionId, after: { commentId, messageId: id }, requestId });
    });
    return { id };
  }

  async setCommentStatus(p: Principal, noteRevisionId: string, commentId: string, status: 'open' | 'resolved', requestId: string): Promise<void> {
    await this.assertCan(p, 'note.comment', noteRevisionId, requestId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE note_comments SET status = ${status}, resolved_by = ${status === 'resolved' ? p.userId : null}, resolved_at = ${status === 'resolved' ? sql`now()` : null} WHERE id = ${commentId} AND note_revision_id = ${noteRevisionId}`);
      await writeAudit(tx, { actorId: p.userId, action: `note.comment_${status}`, objectType: 'note_revision', objectId: noteRevisionId, after: { commentId }, requestId });
    });
  }

  async deleteComment(p: Principal, noteRevisionId: string, commentId: string, requestId: string): Promise<void> {
    await this.assertCan(p, 'note.comment', noteRevisionId, requestId);
    const t = (await this.db.execute(sql`SELECT created_by FROM note_comments WHERE id = ${commentId} AND note_revision_id = ${noteRevisionId}`)).rows[0] as any;
    if (!t) throw notFound('Comment thread');
    if (t.created_by !== p.userId && !hasRole(p, 'reviewer', 'admin')) throw forbidden('Only the author or a reviewer may delete a thread');
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM note_comments WHERE id = ${commentId}`);
      await writeAudit(tx, { actorId: p.userId, action: 'note.comment_delete', objectType: 'note_revision', objectId: noteRevisionId, after: { commentId }, requestId });
    });
  }

  // ---------- lists ----------

  async listVisible(p: Principal, filter: { billKey?: string; state?: string; assignee?: string; page: number; size: number }): Promise<NoteRevisionSummary[]> {
    const conds = [sql`true`];
    if (filter.billKey) conds.push(sql`n.bill_key = ${filter.billKey}`);
    const rows = (await this.db.execute(sql`SELECT r.note_revision_id FROM note_revisions r JOIN notes n ON n.note_id = r.note_id WHERE ${sql.join(conds, sql` AND `)} ORDER BY r.updated_at DESC LIMIT ${filter.size * 4} OFFSET ${(filter.page - 1) * filter.size}`)).rows as any[];
    const out: NoteRevisionSummary[] = [];
    for (const r of rows) {
      const ctx = await this.resource(r.note_revision_id);
      if (!can(p, 'note.read', ctx.res)) continue;
      const s = await this.summary(r.note_revision_id, ctx);
      if (filter.state && s.state !== filter.state) continue;
      if (filter.assignee) {
        const who = filter.assignee === 'me' ? p.userId : filter.assignee;
        if (s.drafter?.userId !== who && s.reviewer?.userId !== who) continue;
      }
      out.push(s);
      if (out.length >= filter.size) break;
    }
    return out;
  }

  /** Visible revisions on a bill, for the bill page and the search indexer. */
  async forBill(p: Principal, billKey: string): Promise<NoteRevisionSummary[]> {
    return this.listVisible(p, { billKey, page: 1, size: 100 });
  }
}
