// Notes module: notes, revisions, documents (autosave heads and named snapshots), comments, locks.
import type { ExportService } from './export/service.js';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { label as shortLabel, type BillType } from '@wa-leg/billref';
import { diffNotes, docToHtml, docToText, extractEstimateData, loadTemplate, recompute, validateNote, type EstimateData, type PMNode, type ValidationResult } from '@wa-leg/note-schema';
import { drafterStatus, reviewerStatus } from '@wa-leg/workflow-machine';
import type { Db, DbOrTx } from '../../db/client.js';
import { badRequest, conflict, forbidden, notFound, preconditionFailed } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/outbox.js';
import { can, hasRole, type NoteResource, type Principal } from '../identity/index.js';
import { buildTemplateContext, fetchBillFacts } from './context.js';
import { readNoteState, type NoteState } from './state.js';

export interface NoteRevisionSummary {
  noteRevisionId: string;
  noteId: string;
  billKey: string;
  biennium: string;
  billId: string;
  billTitle?: string;
  versionCode: string;
  versionLabel: string;
  amendmentId?: string | null;
  kind: 'note' | 'estimate';
  requestId?: string | null;
  requestedAt?: string | null;
  requestedBy?: string | null;
  legContact?: { name?: string; phone?: string } | null;
  tenYearRequested: boolean;
  confidential: boolean;
  priority: string;
  identifier?: string | null;
  state: string;
  drafterStatus: string;
  reviewerStatus: string;
  drafter: { userId: string; displayName?: string } | null;
  reviewer: { userId: string; displayName?: string } | null;
  execChain: { userId: string; division?: string }[];
  execIndex: number;
  deadlines: { kind: string; dueAt: string }[];
  effectiveDueAt?: string | null;
  nextHearingAt?: string | null;
  headVersion: number;
  approvedVersion?: number | null;
  previousRevisionId?: string | null;
  supersededBy?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  mode: 'limited' | 'full';
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeRequestItem {
  id: string;
  seq: number;
  commentId: string | null;
  threadStatus: 'open' | 'resolved' | null;
  anchorText: string | null;
  body: string;
  status: 'open' | 'addressed';
  addressedBy: string | null;
  addressedByName?: string;
  addressedAt: string | null;
  resolution: string | null;
  resolutionVersion: number | null;
}

export interface ChangeRequest {
  id: string;
  noteRevisionId: string;
  transitionSeq: number | null;
  event: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  documentVersion: number | null;
  summary: string;
  status: 'open' | 'closed';
  closedBy: string | null;
  closedByName?: string;
  closedAt: string | null;
  resolution: string | null;
  resolutionVersion: number | null;
  openItems: number;
  items: ChangeRequestItem[];
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
    const r = (await this.db.execute(sql`SELECT r.*, n.bill_key, n.request_id, n.request_source, n.requested_at, n.requested_by, n.leg_contact, n.ten_year_requested,
        n.confidential, n.kind, n.priority, n.identifier, n.created_by AS note_created_by
      FROM note_revisions r JOIN notes n ON n.note_id = r.note_id WHERE r.note_revision_id = ${noteRevisionId}`)).rows[0];
    if (!r) throw notFound('Note revision');
    return r;
  }

  private readonly userCache = new Map<string, { at: number; name?: string; division: string | null }>();

  private async user(userId: string): Promise<{ name?: string; division: string | null }> {
    const hit = this.userCache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const r = (await this.db.execute(sql`SELECT display_name, divisions FROM users WHERE user_id = ${userId}`)).rows[0] as any;
    const entry = { at: Date.now(), name: r?.display_name ?? undefined, division: (r?.divisions?.[0] as string | undefined) ?? null };
    this.userCache.set(userId, entry);
    return entry;
  }

  private async userName(userId: string | null): Promise<string | undefined> {
    if (!userId) return undefined;
    return (await this.user(userId)).name;
  }

  /** Resource for `can()` from a revision row and its workflow state. */
  async resource(noteRevisionId: string): Promise<{ row: any; state: NoteState; res: NoteResource }> {
    const row = await this.revisionRow(noteRevisionId);
    const state = await readNoteState(this.app, noteRevisionId, row.drafter_id ?? null);
    const participants = ((await this.db.execute(sql`SELECT DISTINCT created_by AS u FROM note_comments WHERE note_revision_id = ${noteRevisionId}
        UNION SELECT DISTINCT author_id FROM note_comment_messages m JOIN note_comments c ON c.id = m.comment_id WHERE c.note_revision_id = ${noteRevisionId}`)).rows as any[]).map((r) => r.u as string);
    const drafterDivision = state.drafterId ? (await this.user(state.drafterId)).division : null;
    const res: NoteResource = {
      type: 'note',
      state: state.state,
      drafterId: state.drafterId,
      reviewerId: state.reviewerId,
      execChain: state.execChain,
      execIndex: state.execIndex,
      confidential: !!row.confidential,
      division: drafterDivision,
      kind: row.kind,
      participantIds: [...participants, row.note_created_by, row.created_by].filter(Boolean),
    };
    return { row, state, res };
  }

  private canOpts() {
    return { divisionRead: this.app.config.DIVISION_READ, reviewerEdit: this.app.config.REVIEWER_EDIT };
  }

  async assertCan(p: Principal, action: Parameters<typeof can>[1], noteRevisionId: string, requestId?: string): Promise<{ row: any; state: NoteState; res: NoteResource }> {
    const ctx = await this.resource(noteRevisionId);
    if (!can(p, action, ctx.res, this.canOpts())) {
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
    const editable = (() => {
      if (['todo', 'in_progress', 'changes_requested'].includes(state.state)) return true;
      if (state.state === 'review.active') return this.app.config.REVIEWER_EDIT;
      if (state.state === 'exec_review.active') return true;
      return false;
    })();
    const deadlines = state.deadlines ?? [];
    const effective = deadlines.map((d) => d.dueAt).sort()[0] ?? null;
    const supersededBy = state.supersededBy ?? ((await this.db.execute(sql`SELECT note_revision_id FROM note_revisions WHERE previous_revision_id = ${noteRevisionId} ORDER BY created_at DESC LIMIT 1`)).rows[0] as any)?.note_revision_id ?? null;
    return {
      noteRevisionId,
      noteId: row.note_id,
      billKey: row.bill_key,
      biennium: biennium ?? '',
      billId: billId ?? '',
      billTitle: facts?.title,
      versionCode: row.version_code,
      versionLabel,
      amendmentId: row.amendment_id ?? null,
      kind: row.kind,
      requestId: row.request_id ?? null,
      requestedAt: row.requested_at ? iso(row.requested_at) : null,
      requestedBy: row.requested_by ?? null,
      legContact: row.leg_contact ?? null,
      tenYearRequested: !!row.ten_year_requested,
      confidential: !!row.confidential,
      priority: row.priority,
      identifier: row.identifier ?? null,
      state: state.state,
      drafterStatus: drafterStatus(state.state),
      reviewerStatus: reviewerStatus(state.state),
      drafter: state.drafterId ? { userId: state.drafterId, displayName: await this.userName(state.drafterId) } : null,
      reviewer: state.reviewerId ? { userId: state.reviewerId, displayName: await this.userName(state.reviewerId) } : null,
      execChain: state.execChain,
      execIndex: state.execIndex,
      deadlines,
      effectiveDueAt: effective,
      nextHearingAt: facts?.hearings.filter((h) => !h.cancelled && new Date(h.hearingAt) > new Date()).map((h) => h.hearingAt).sort()[0] ?? null,
      headVersion: row.head_version,
      approvedVersion: row.approved_document_version ?? null,
      previousRevisionId: row.previous_revision_id ?? null,
      supersededBy,
      templateId: row.template_id ?? null,
      templateVersion: row.template_version ?? null,
      mode: row.mode,
      editable,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  // ---------- create ----------

  async create(
    p: Principal,
    input: {
      billKey: string;
      versionCode: string;
      amendmentId?: string;
      kind?: 'note' | 'estimate';
      templateId?: string;
      cloneFromRevisionId?: string;
      request?: { requestId?: string; requestedAt?: string; requestedBy?: string; legContact?: { name?: string; phone?: string }; tenYearRequested?: boolean };
      confidential?: boolean;
      drafterId?: string;
      priority?: string;
    },
    requestId: string,
  ): Promise<NoteRevisionSummary> {
    const kind = input.kind ?? 'note';
    if (!can(p, 'note.create', { type: 'note.create', kind, drafterId: input.drafterId ?? null })) {
      await writeAudit(this.db, { actorId: p.userId, action: 'permission.denied', objectType: 'note', objectId: input.billKey, after: { action: 'note.create' }, requestId });
      throw forbidden('Not allowed: note.create');
    }
    const facts = await fetchBillFacts(this.app, input.billKey, p);
    if (!facts) throw notFound(`Bill ${input.billKey}`);
    if (!facts.versions.some((v) => v.code === input.versionCode)) throw badRequest('unknown_version', `Version ${input.versionCode} of ${facts.id} is not loaded`);
    const noteId = randomUUID();
    const noteRevisionId = randomUUID();
    const drafterId = input.drafterId ?? (kind === 'estimate' && p.roles.includes('drafter') ? p.userId : p.roles.includes('drafter') && !p.roles.includes('reviewer') ? p.userId : null);
    const requestedAt = input.request?.requestedAt ?? new Date().toISOString();
    const hearingAt = facts.hearings.filter((h) => !h.cancelled && new Date(h.hearingAt) > new Date()).map((h) => h.hearingAt).sort()[0] ?? null;

    // Initial document: from a template, a prior revision, or an empty limited-mode skeleton.
    let doc: PMNode;
    let templateId: string | null = null;
    let templateVersion: number | null = null;
    const prior = input.cloneFromRevisionId ? await this.revisionRow(input.cloneFromRevisionId) : null;
    if (input.cloneFromRevisionId) {
      const head = await this.getDocument(input.cloneFromRevisionId);
      doc = head.doc;
      templateId = head.templateId ?? null;
      templateVersion = head.templateVersion ?? null;
    } else if (input.templateId) {
      const t = await this.app.templates.get(input.templateId);
      const ctx = await buildTemplateContext(this.app, { billKey: input.billKey, versionCode: input.versionCode, amendmentId: input.amendmentId, requestId: input.request?.requestId, requestedAt, legContact: input.request?.legContact, tenYearRequested: input.request?.tenYearRequested, noteRevisionId }, p);
      const jobs = (await this.app.reference.get('job-classes')) as { classes: { title: string; salary: number }[] };
      ctx.fteClass = jobs.classes.slice(0, 12).map((c) => ({ title: c.title, salary: c.salary.toLocaleString('en-US') }));
      doc = loadTemplate(t.html, ctx, { mode: t.mode }).doc;
      templateId = t.id;
      templateVersion = t.version;
    } else {
      doc = { type: 'doc', content: [{ type: 'noteSection', attrs: { part: 'II.A' }, content: [{ type: 'paragraph', content: [] }] }] };
    }

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO notes (note_id, bill_key, request_id, request_source, requested_at, requested_by, leg_contact, ten_year_requested, confidential, kind, priority, created_by)
        VALUES (${noteId}, ${input.billKey}, ${input.request?.requestId ?? null}, 'manual', ${requestedAt}::timestamptz, ${input.request?.requestedBy ?? p.userId},
          ${input.request?.legContact ? JSON.stringify(input.request.legContact) : null}::jsonb, ${!!input.request?.tenYearRequested}, ${!!input.confidential}, ${kind}, ${input.priority ?? 'normal'}, ${p.userId})`);
      await tx.execute(sql`INSERT INTO note_revisions (note_revision_id, note_id, version_code, amendment_id, previous_revision_id, drafter_id, template_id, template_version, mode, head_version, created_by)
        VALUES (${noteRevisionId}, ${noteId}, ${input.versionCode}, ${input.amendmentId ?? null}, ${prior ? input.cloneFromRevisionId : null}, ${drafterId}, ${templateId}, ${templateVersion}, 'limited', 1, ${p.userId})`);
      await this.storeDocument(tx, noteRevisionId, 1, doc, 'limited', p.userId, { label: prior ? `Cloned from ${prior.note_revision_id}` : templateId ? `Template ${templateId}` : 'Created' });
      await writeAudit(tx, { actorId: p.userId, action: 'note.create', objectType: 'note_revision', objectId: noteRevisionId, after: { noteId, billKey: input.billKey, versionCode: input.versionCode, templateId, drafterId }, requestId });
      await emitEvent(tx, 'note.created', { noteId, noteRevisionId, billKey: input.billKey, versionCode: input.versionCode, drafterId, kind });
      await emitEvent(tx, 'fiscal_note.requested', { noteRevisionId, billKey: input.billKey, versionCode: input.versionCode, requestedAt, hearingAt, requestedBy: input.request?.requestedBy ?? p.userId, drafterId, priority: input.priority ?? 'normal', confidential: !!input.confidential });
    });
    this.app.bus.kick();
    await this.app.bus.drain(3000);
    return this.summary(noteRevisionId);
  }

  /** Next revision for a new bill version or amendment, cloning the head document. */
  async createRevision(p: Principal, fromRevisionId: string, input: { versionCode: string; amendmentId?: string }, requestId: string): Promise<NoteRevisionSummary> {
    const { row, state } = await this.assertCan(p, 'note.read', fromRevisionId, requestId);
    if (!can(p, 'note.assign', (await this.resource(fromRevisionId)).res) && state.drafterId !== p.userId) throw forbidden('Only the drafter or an assigner can create a revision');
    const head = await this.getDocument(fromRevisionId);
    const noteRevisionId = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO note_revisions (note_revision_id, note_id, version_code, amendment_id, previous_revision_id, drafter_id, template_id, template_version, mode, head_version, created_by)
        VALUES (${noteRevisionId}, ${row.note_id}, ${input.versionCode}, ${input.amendmentId ?? null}, ${fromRevisionId}, ${state.drafterId}, ${head.templateId ?? null}, ${head.templateVersion ?? null}, ${head.mode}, 1, ${p.userId})`);
      await this.storeDocument(tx, noteRevisionId, 1, head.doc, head.mode, p.userId, { label: `Cloned from revision on ${row.version_code}` });
      await writeAudit(tx, { actorId: p.userId, action: 'note.revision_create', objectType: 'note_revision', objectId: noteRevisionId, before: { previousRevisionId: fromRevisionId }, after: { versionCode: input.versionCode }, requestId });
      await emitEvent(tx, 'note.revision_created', { noteId: row.note_id, noteRevisionId, billKey: row.bill_key, versionCode: input.versionCode, previousRevisionId: fromRevisionId, drafterId: state.drafterId, execChain: state.execChain });
    });
    this.app.bus.kick();
    await this.app.bus.drain(3000);
    return this.summary(noteRevisionId);
  }

  async patch(p: Principal, noteRevisionId: string, patch: { confidential?: boolean; priority?: string; identifier?: string; request?: { requestId?: string; requestedAt?: string; requestedBy?: string; legContact?: { name?: string; phone?: string }; tenYearRequested?: boolean } }, requestId: string): Promise<NoteRevisionSummary> {
    const { row } = await this.assertCan(p, 'note.patch', noteRevisionId, requestId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE notes SET confidential = COALESCE(${patch.confidential ?? null}, confidential), priority = COALESCE(${patch.priority ?? null}, priority),
        identifier = COALESCE(${patch.identifier ?? null}, identifier), request_id = COALESCE(${patch.request?.requestId ?? null}, request_id),
        requested_at = COALESCE(${patch.request?.requestedAt ?? null}::timestamptz, requested_at), requested_by = COALESCE(${patch.request?.requestedBy ?? null}, requested_by),
        leg_contact = COALESCE(${patch.request?.legContact ? JSON.stringify(patch.request.legContact) : null}::jsonb, leg_contact),
        ten_year_requested = COALESCE(${patch.request?.tenYearRequested ?? null}, ten_year_requested), updated_at = now() WHERE note_id = ${row.note_id}`);
      await writeAudit(tx, { actorId: p.userId, action: 'note.patch', objectType: 'note_revision', objectId: noteRevisionId, after: patch, requestId });
      await emitEvent(tx, 'note.document_saved', { noteRevisionId, version: row.head_version, actorId: p.userId, metadata: true });
    });
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

  async saveDocument(p: Principal, noteRevisionId: string, ifMatch: string, body: { doc: PMNode; mode: 'limited' | 'full'; clientId?: string }, force: boolean, requestId: string): Promise<{ version: number; savedAt: string; estimateData: EstimateData; validation: ValidationResult }> {
    const ctx = await this.assertCan(p, 'note.edit', noteRevisionId, requestId);
    const expected = Number(ifMatch.replace(/^W\//, '').replace(/"/g, ''));
    if (!Number.isFinite(expected)) throw badRequest('bad_if_match', 'If-Match must carry the current document version');
    return this.db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`SELECT head_version FROM note_revisions WHERE note_revision_id = ${noteRevisionId} FOR UPDATE`)).rows[0] as any;
      const head = Number(locked.head_version);
      if (head !== expected && !force) {
        const current = (await tx.execute(sql`SELECT version, doc_json, updated_by, updated_at FROM note_documents WHERE note_revision_id = ${noteRevisionId} AND version = ${head}`)).rows[0] as any;
        throw preconditionFailed({ version: head, doc: current?.doc_json, updatedBy: current?.updated_by, updatedByName: await this.userName(current?.updated_by ?? null), updatedAt: current ? iso(current.updated_at) : null });
      }
      let next = head + 1;
      if (head !== expected && force) {
        // Keep the server's head as a labelled snapshot, then store the client's document on top.
        await tx.execute(sql`UPDATE note_documents SET label = COALESCE(label, 'Superseded by a forced save') WHERE note_revision_id = ${noteRevisionId} AND version = ${head}`);
        next = head + 1;
      }
      const { estimate, validation } = await this.storeDocument(tx, noteRevisionId, next, body.doc, body.mode, p.userId, { clientId: body.clientId ?? null });
      await writeAudit(tx, { actorId: p.userId, action: 'note.document_save', objectType: 'note_revision', objectId: noteRevisionId, before: { version: head }, after: { version: next, forced: head !== expected }, requestId });
      await emitEvent(tx, 'note.document_saved', { noteRevisionId, version: next, actorId: p.userId });
      void ctx;
      return { version: next, savedAt: new Date().toISOString(), estimateData: estimate, validation };
    });
  }

  async listVersions(noteRevisionId: string) {
    const rows = (await this.db.execute(sql`SELECT version, label, summary, updated_by, updated_at, validation FROM note_documents WHERE note_revision_id = ${noteRevisionId} ORDER BY version DESC`)).rows as any[];
    const names = new Map<string, string | undefined>();
    for (const r of rows) if (!names.has(r.updated_by)) names.set(r.updated_by, await this.userName(r.updated_by));
    return rows.map((r) => ({ version: r.version, label: r.label ?? null, createdBy: r.updated_by, createdByName: names.get(r.updated_by) ?? null, createdAt: iso(r.updated_at), summary: r.summary ?? (r.validation?.ok === false ? `${r.validation.errors.length} validation error(s)` : null) }));
  }

  async snapshot(p: Principal, noteRevisionId: string, label: string | undefined, requestId: string): Promise<{ version: number }> {
    const { row } = await this.assertCan(p, 'note.read', noteRevisionId, requestId);
    await this.db.execute(sql`UPDATE note_documents SET label = ${label ?? 'Snapshot'} WHERE note_revision_id = ${noteRevisionId} AND version = ${row.head_version}`);
    await writeAudit(this.db, { actorId: p.userId, action: 'note.snapshot', objectType: 'note_revision', objectId: noteRevisionId, after: { version: row.head_version, label }, requestId });
    return { version: row.head_version };
  }

  async restore(p: Principal, noteRevisionId: string, version: number, requestId: string): Promise<{ version: number }> {
    const { row } = await this.assertCan(p, 'note.edit', noteRevisionId, requestId);
    const old = await this.getDocument(noteRevisionId, version);
    return this.db.transaction(async (tx) => {
      const next = Number(row.head_version) + 1;
      await this.storeDocument(tx, noteRevisionId, next, old.doc, old.mode, p.userId, { label: `Restored from version ${version}` });
      await writeAudit(tx, { actorId: p.userId, action: 'note.restore', objectType: 'note_revision', objectId: noteRevisionId, before: { version: row.head_version }, after: { version: next, restoredFrom: version }, requestId });
      await emitEvent(tx, 'note.document_saved', { noteRevisionId, version: next, actorId: p.userId });
      return { version: next };
    });
  }

  async diff(noteRevisionId: string, from: number, to: number) {
    const a = await this.getDocument(noteRevisionId, from);
    const b = await this.getDocument(noteRevisionId, to);
    return diffNotes(a.doc, b.doc);
  }

  async validate(noteRevisionId: string): Promise<ValidationResult> {
    const d = await this.getDocument(noteRevisionId);
    return validateNote(recompute(d.doc).doc);
  }

  // ---------- locks ----------

  async lock(p: Principal, noteRevisionId: string, ttlSeconds = 120): Promise<{ holder: string; holderName?: string; expiresAt: string; mine: boolean }> {
    await this.assertCan(p, 'note.edit', noteRevisionId);
    const now = new Date();
    const exp = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
    return this.db.transaction(async (tx) => {
      const cur = (await tx.execute(sql`SELECT holder, expires_at FROM note_locks WHERE note_revision_id = ${noteRevisionId} FOR UPDATE`)).rows[0] as any;
      if (cur && cur.holder !== p.userId && new Date(cur.expires_at) > now) {
        throw conflict('locked', 'Held by another user', { holder: cur.holder, holderName: await this.userName(cur.holder), expiresAt: iso(cur.expires_at) });
      }
      await tx.execute(sql`INSERT INTO note_locks (note_revision_id, holder, expires_at) VALUES (${noteRevisionId}, ${p.userId}, ${exp}::timestamptz)
        ON CONFLICT (note_revision_id) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at`);
      return { holder: p.userId, holderName: p.displayName, expiresAt: exp, mine: true };
    });
  }

  async unlock(p: Principal, noteRevisionId: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM note_locks WHERE note_revision_id = ${noteRevisionId} AND holder = ${p.userId}`);
  }

  async lockStatus(noteRevisionId: string): Promise<{ holder: string; holderName?: string; expiresAt: string } | null> {
    const cur = (await this.db.execute(sql`SELECT holder, expires_at FROM note_locks WHERE note_revision_id = ${noteRevisionId} AND expires_at > now()`)).rows[0] as any;
    return cur ? { holder: cur.holder, holderName: await this.userName(cur.holder), expiresAt: iso(cur.expires_at) } : null;
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
    await this.assertCan(p, 'note.comment_reply', noteRevisionId, requestId);
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
    await this.assertCan(p, 'note.comment_reply', noteRevisionId, requestId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE note_comments SET status = ${status}, resolved_by = ${status === 'resolved' ? p.userId : null}, resolved_at = ${status === 'resolved' ? sql`now()` : null} WHERE id = ${commentId} AND note_revision_id = ${noteRevisionId}`);
      await writeAudit(tx, { actorId: p.userId, action: `note.comment_${status}`, objectType: 'note_revision', objectId: noteRevisionId, after: { commentId }, requestId });
    });
  }

  async deleteComment(p: Principal, noteRevisionId: string, commentId: string, requestId: string): Promise<void> {
    const ctx = await this.assertCan(p, 'note.comment_reply', noteRevisionId, requestId);
    const t = (await this.db.execute(sql`SELECT created_by FROM note_comments WHERE id = ${commentId} AND note_revision_id = ${noteRevisionId}`)).rows[0] as any;
    if (!t) throw notFound('Comment thread');
    const reviewer = can(p, 'note.review', ctx.res, this.canOpts()) || p.roles.includes('reviewer') || p.roles.includes('admin');
    if (t.created_by !== p.userId && !reviewer) throw forbidden('Only the author or a reviewer may delete a thread');
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
      if (!can(p, 'note.read', ctx.res, this.canOpts())) continue;
      const s = await this.summary(r.note_revision_id, ctx);
      if (filter.state && s.state !== filter.state) continue;
      if (filter.assignee) {
        const who = filter.assignee === 'me' ? p.userId : filter.assignee;
        if (s.drafter?.userId !== who && s.reviewer?.userId !== who && !s.execChain.some((e) => e.userId === who)) continue;
      }
      out.push(s);
      if (out.length >= filter.size) break;
    }
    return out;
  }

  /** Everything the search indexer and the bill page need: visible revisions on a bill grouped by version. */
  async forBill(p: Principal, billKey: string): Promise<NoteRevisionSummary[]> {
    return this.listVisible(p, { billKey, page: 1, size: 100 });
  }

  // ---------- change requests ----------

  /** Bullet or numbered lines of a request comment become items; the rest is the summary. */
  static splitRequest(text: string): { summary: string; items: string[] } {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const items: string[] = [];
    const rest: string[] = [];
    for (const l of lines) {
      const m = /^(?:[-*•]|\d{1,2}[.)])\s+(.+)$/.exec(l);
      if (m) items.push(m[1]!.trim());
      else if (l) rest.push(l);
    }
    return { summary: rest.join('\n'), items };
  }

  /**
   * Record what a reviewer asked for when returning the note. Called by the workflow module after REQUEST_CHANGES or
   * EXEC_RETURN. Each bullet line of the comment and each open comment thread becomes an item; a comment with neither
   * becomes a single item so the drafter still has something to close.
   */
  async recordChangeRequest(p: Principal, noteRevisionId: string, input: { transitionSeq?: number; event?: string; summary: string }, requestId: string): Promise<ChangeRequest> {
    const { row } = await this.resource(noteRevisionId);
    const existing = input.transitionSeq !== undefined ? ((await this.db.execute(sql`SELECT id FROM note_change_requests WHERE note_revision_id = ${noteRevisionId} AND transition_seq = ${input.transitionSeq}`)).rows[0] as { id: string } | undefined) : undefined;
    if (existing) return (await this.listChangeRequests(noteRevisionId)).find((c) => c.id === existing.id)!;
    const { summary, items } = NotesService.splitRequest(input.summary);
    const threads = (await this.listComments(noteRevisionId)).filter((t) => t.status === 'open' && !t.detached);
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO note_change_requests (id, note_revision_id, transition_seq, event, requested_by, document_version, summary)
        VALUES (${id}, ${noteRevisionId}, ${input.transitionSeq ?? null}, ${input.event ?? 'REQUEST_CHANGES'}, ${p.userId}, ${row.head_version}, ${summary || input.summary})`);
      let seq = 0;
      const rows: { commentId: string | null; anchor: string | null; body: string }[] = items.map((body) => ({ commentId: null, anchor: null, body }));
      for (const t of threads) rows.push({ commentId: t.id, anchor: t.anchorText, body: t.messages[0]?.body ?? t.anchorText });
      if (rows.length === 0) rows.push({ commentId: null, anchor: null, body: input.summary.trim() || 'Address the reviewer\u2019s request' });
      for (const r of rows) {
        await tx.execute(sql`INSERT INTO note_change_request_items (id, change_request_id, seq, comment_id, anchor_text, body) VALUES (${randomUUID()}, ${id}, ${++seq}, ${r.commentId}, ${r.anchor}, ${r.body})`);
      }
      await writeAudit(tx, { actorId: p.userId, action: 'note.change_request_open', objectType: 'note_revision', objectId: noteRevisionId, after: { changeRequestId: id, items: rows.length, transitionSeq: input.transitionSeq ?? null }, requestId });
    });
    return (await this.listChangeRequests(noteRevisionId)).find((c) => c.id === id)!;
  }

  async listChangeRequests(noteRevisionId: string): Promise<ChangeRequest[]> {
    const reqs = (await this.db.execute(sql`SELECT * FROM note_change_requests WHERE note_revision_id = ${noteRevisionId} ORDER BY requested_at DESC`)).rows as any[];
    if (reqs.length === 0) return [];
    const items = (await this.db.execute(sql`SELECT i.*, c.status AS thread_status FROM note_change_request_items i JOIN note_change_requests r ON r.id = i.change_request_id LEFT JOIN note_comments c ON c.id = i.comment_id WHERE r.note_revision_id = ${noteRevisionId} ORDER BY i.seq`)).rows as any[];
    const names = new Map<string, string | undefined>();
    const nameOf = async (u: string | null): Promise<string | undefined> => {
      if (!u) return undefined;
      if (!names.has(u)) names.set(u, await this.userName(u));
      return names.get(u);
    };
    const out: ChangeRequest[] = [];
    for (const r of reqs) {
      const its: ChangeRequestItem[] = [];
      for (const i of items.filter((x) => x.change_request_id === r.id)) {
        its.push({ id: i.id, seq: i.seq, commentId: i.comment_id ?? null, threadStatus: i.thread_status ?? null, anchorText: i.anchor_text ?? null, body: i.body, status: i.status, addressedBy: i.addressed_by ?? null, addressedByName: await nameOf(i.addressed_by ?? null), addressedAt: i.addressed_at ? iso(i.addressed_at) : null, resolution: i.resolution ?? null, resolutionVersion: i.resolution_version ?? null });
      }
      out.push({
        id: r.id,
        noteRevisionId,
        transitionSeq: r.transition_seq ?? null,
        event: r.event,
        requestedBy: r.requested_by,
        requestedByName: await nameOf(r.requested_by),
        requestedAt: iso(r.requested_at),
        documentVersion: r.document_version ?? null,
        summary: r.summary,
        status: r.status,
        closedBy: r.closed_by ?? null,
        closedByName: await nameOf(r.closed_by ?? null),
        closedAt: r.closed_at ? iso(r.closed_at) : null,
        resolution: r.resolution ?? null,
        resolutionVersion: r.resolution_version ?? null,
        openItems: its.filter((i) => i.status === 'open').length,
        items: its,
      });
    }
    return out;
  }

  private async changeRequestItem(noteRevisionId: string, crId: string, itemId: string): Promise<any> {
    const i = (await this.db.execute(sql`SELECT i.* FROM note_change_request_items i JOIN note_change_requests r ON r.id = i.change_request_id WHERE i.id = ${itemId} AND r.id = ${crId} AND r.note_revision_id = ${noteRevisionId}`)).rows[0];
    if (!i) throw notFound('Change request item');
    return i;
  }

  /** The drafter (or whoever may edit the note) marks an item addressed, citing how; the linked thread gets a reply and is resolved. */
  async addressChangeRequestItem(p: Principal, noteRevisionId: string, crId: string, itemId: string, input: { resolution: string }, requestId: string): Promise<void> {
    const ctx = await this.resource(noteRevisionId);
    const allowed = can(p, 'note.edit', ctx.res, this.canOpts()) || ctx.state.drafterId === p.userId || can(p, 'note.review', ctx.res, this.canOpts()) || hasRole(p, 'admin');
    if (!allowed) throw forbidden('Only the drafter or a reviewer may address a change request item');
    const item = await this.changeRequestItem(noteRevisionId, crId, itemId);
    const version = Number(ctx.row.head_version);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE note_change_request_items SET status = 'addressed', addressed_by = ${p.userId}, addressed_at = now(), resolution = ${input.resolution}, resolution_version = ${version} WHERE id = ${itemId}`);
      if (item.comment_id) {
        await tx.execute(sql`INSERT INTO note_comment_messages (id, comment_id, author_id, body) VALUES (${`m_${randomUUID()}`}, ${item.comment_id}, ${p.userId}, ${`Addressed in version ${version}: ${input.resolution}`})`);
        await tx.execute(sql`UPDATE note_comments SET status = 'resolved', resolved_by = ${p.userId}, resolved_at = now() WHERE id = ${item.comment_id}`);
      }
      await writeAudit(tx, { actorId: p.userId, action: 'note.change_request_item_addressed', objectType: 'note_revision', objectId: noteRevisionId, after: { changeRequestId: crId, itemId, version }, requestId });
    });
  }

  /** Reopen an item (the reviewer is not satisfied, or the drafter changed their mind). */
  async reopenChangeRequestItem(p: Principal, noteRevisionId: string, crId: string, itemId: string, input: { reason?: string }, requestId: string): Promise<void> {
    const ctx = await this.resource(noteRevisionId);
    const allowed = ctx.state.drafterId === p.userId || can(p, 'note.assign') || can(p, 'note.review', ctx.res, this.canOpts());
    if (!allowed) throw forbidden('Only the drafter or a reviewer may reopen a change request item');
    const item = await this.changeRequestItem(noteRevisionId, crId, itemId);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE note_change_request_items SET status = 'open', addressed_by = NULL, addressed_at = NULL, resolution = NULL, resolution_version = NULL WHERE id = ${itemId}`);
      await tx.execute(sql`UPDATE note_change_requests SET status = 'open', closed_by = NULL, closed_at = NULL WHERE id = ${crId}`);
      if (item.comment_id) {
        await tx.execute(sql`UPDATE note_comments SET status = 'open', resolved_by = NULL, resolved_at = NULL WHERE id = ${item.comment_id}`);
        if (input.reason) await tx.execute(sql`INSERT INTO note_comment_messages (id, comment_id, author_id, body) VALUES (${`m_${randomUUID()}`}, ${item.comment_id}, ${p.userId}, ${`Reopened: ${input.reason}`})`);
      }
      await writeAudit(tx, { actorId: p.userId, action: 'note.change_request_item_reopened', objectType: 'note_revision', objectId: noteRevisionId, after: { changeRequestId: crId, itemId, reason: input.reason ?? null }, requestId });
    });
  }

  /** Close the request once every item is addressed; the resolution is the drafter's note to the reviewer. */
  async closeChangeRequest(p: Principal, noteRevisionId: string, crId: string, input: { resolution: string }, requestId: string): Promise<void> {
    const ctx = await this.resource(noteRevisionId);
    const allowed = ctx.state.drafterId === p.userId || can(p, 'note.assign') || hasRole(p, 'admin');
    if (!allowed) throw forbidden('Only the drafter or an assigner may close a change request');
    const cr = (await this.db.execute(sql`SELECT id, status FROM note_change_requests WHERE id = ${crId} AND note_revision_id = ${noteRevisionId}`)).rows[0] as { id: string; status: string } | undefined;
    if (!cr) throw notFound('Change request');
    const open = (await this.db.execute(sql`SELECT count(*)::int AS n FROM note_change_request_items WHERE change_request_id = ${crId} AND status = 'open'`)).rows[0] as { n: number };
    if (Number(open.n) > 0) throw conflict('change_request_items_open', `${open.n} item(s) are still open; address each one before closing the request`, { openItems: Number(open.n) });
    const version = Number(ctx.row.head_version);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE note_change_requests SET status = 'closed', closed_by = ${p.userId}, closed_at = now(), resolution = ${input.resolution}, resolution_version = ${version} WHERE id = ${crId}`);
      await writeAudit(tx, { actorId: p.userId, action: 'note.change_request_close', objectType: 'note_revision', objectId: noteRevisionId, after: { changeRequestId: crId, version }, requestId });
    });
  }

  /** Counts the workflow module checks before letting the drafter resubmit. */
  async changeRequestStatus(noteRevisionId: string): Promise<{ openRequestId: string | null; openItems: number }> {
    const r = (await this.db.execute(sql`SELECT r.id, (SELECT count(*)::int FROM note_change_request_items i WHERE i.change_request_id = r.id AND i.status = 'open') AS open_items
      FROM note_change_requests r WHERE r.note_revision_id = ${noteRevisionId} AND r.status = 'open' ORDER BY r.requested_at DESC LIMIT 1`)).rows[0] as { id: string; open_items: number } | undefined;
    return { openRequestId: r?.id ?? null, openItems: Number(r?.open_items ?? 0) };
  }

  async templateContext(noteRevisionId: string, p: Principal) {
    const row = await this.revisionRow(noteRevisionId);
    const prior = row.previous_revision_id ? await this.revisionRow(row.previous_revision_id).catch(() => null) : null;
    return buildTemplateContext(this.app, { billKey: row.bill_key, versionCode: row.version_code, amendmentId: row.amendment_id, requestId: row.request_id, requestedAt: row.requested_at ? iso(row.requested_at) : null, legContact: row.leg_contact, tenYearRequested: !!row.ten_year_requested, noteRevisionId, prior: prior ? { requestId: prior.request_id ?? undefined, versionLabel: prior.version_code } : null }, p);
  }
}
