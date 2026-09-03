// Workflow module: one instance per note revision, moved by the transition table in @wa-leg/workflow-machine.
// Every event writes the instance, an append-only transition row and an audit row in one transaction;
// APPROVE freezes the head document version, PUBLISH stamps the revision and emits `note.published`.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { EVENT_LABELS, availableEvents, isEditable, transition, type Ctx, type EventType, type WorkflowState } from '@wa-leg/workflow-machine';
import type { Db, DbOrTx } from '../../db/client.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/outbox.js';
import { conflict, notFound } from '../../lib/errors.js';
import { pgTextArray } from '../../lib/sql.js';
import type { Principal } from '../identity/index.js';

export interface InstanceRow {
  id: string;
  note_revision_id: string;
  bill_key: string;
  bill_version_id: string;
  state: WorkflowState;
  drafter_id: string | null;
  reviewer_id: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface UserRef {
  userId: string;
  displayName?: string;
}

export interface ChangeRequestView {
  message: string;
  by: UserRef;
  at: string;
}

export interface WorkflowView {
  instanceId: string;
  noteRevisionId: string;
  state: WorkflowState;
  version: number;
  drafter: UserRef | null;
  reviewer: UserRef | null;
  availableEvents: { type: EventType; label: string }[];
  /** The open change request while the state is `changes_requested`. */
  changeRequest: ChangeRequestView | null;
  /** The caller is the drafter and the state allows editing. */
  editable: boolean;
  updatedAt: string;
}

export interface TransitionRow {
  seq: number;
  event: string;
  fromState: string;
  toState: string;
  actorId: string;
  actorName?: string | null;
  comment: string | null;
  payload: unknown;
  occurredAt: string;
}

export interface TransitionBody {
  event: EventType;
  message?: string;
  expectedVersion?: number;
}

export interface TransitionOutcome {
  instanceId: string;
  state: WorkflowState;
  version: number;
  seq: number;
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());

export class WorkflowService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly db: Db,
  ) {}

  // ---------- reads ----------

  async instanceByNote(noteRevisionId: string, tx: DbOrTx = this.db, forUpdate = false): Promise<InstanceRow | null> {
    const rows = (await tx.execute(forUpdate ? sql`SELECT * FROM workflow_instances WHERE note_revision_id = ${noteRevisionId} FOR UPDATE` : sql`SELECT * FROM workflow_instances WHERE note_revision_id = ${noteRevisionId}`)).rows as unknown as InstanceRow[];
    return rows[0] ?? null;
  }

  async requireInstance(noteRevisionId: string): Promise<InstanceRow> {
    const row = await this.instanceByNote(noteRevisionId);
    if (!row) throw notFound('Workflow instance');
    return row;
  }

  private async userRef(userId: string | null): Promise<UserRef | null> {
    if (!userId) return null;
    const r = (await this.db.execute(sql`SELECT display_name FROM users WHERE user_id = ${userId}`)).rows[0] as { display_name: string } | undefined;
    return { userId, displayName: r?.display_name ?? (userId === 'system' ? 'System' : undefined) };
  }

  async openChangeRequest(noteRevisionId: string, tx: DbOrTx = this.db): Promise<ChangeRequestView | null> {
    const r = (await tx.execute(sql`SELECT c.summary, c.requested_by, c.requested_at, u.display_name FROM note_change_requests c LEFT JOIN users u ON u.user_id = c.requested_by
      WHERE c.note_revision_id = ${noteRevisionId} AND c.resolved_at IS NULL ORDER BY c.requested_at DESC LIMIT 1`)).rows[0] as { summary: string; requested_by: string; requested_at: Date | string; display_name: string | null } | undefined;
    if (!r) return null;
    return { message: r.summary, by: { userId: r.requested_by, displayName: r.display_name ?? undefined }, at: iso(r.requested_at)! };
  }

  async view(noteRevisionId: string, principal: Principal): Promise<WorkflowView> {
    const row = await this.requireInstance(noteRevisionId);
    const ctx: Ctx = { drafterId: row.drafter_id, reviewerId: row.reviewer_id };
    return {
      instanceId: row.id,
      noteRevisionId: row.note_revision_id,
      state: row.state,
      version: row.version,
      drafter: await this.userRef(row.drafter_id),
      reviewer: await this.userRef(row.reviewer_id),
      availableEvents: availableEvents(row.state, principal, ctx).map((type) => ({ type, label: EVENT_LABELS[type] })),
      changeRequest: row.state === 'changes_requested' ? await this.openChangeRequest(noteRevisionId) : null,
      editable: isEditable(row.state) && row.drafter_id === principal.userId,
      updatedAt: iso(row.updated_at)!,
    };
  }

  async transitions(noteRevisionId: string, opts: { limit?: number; before?: number } = {}): Promise<TransitionRow[]> {
    const row = await this.requireInstance(noteRevisionId);
    const limit = Math.min(opts.limit ?? 200, 500);
    const rows = (await this.db.execute(sql`SELECT t.*, u.display_name FROM workflow_transitions t LEFT JOIN users u ON u.user_id = t.actor_id
      WHERE t.instance_id = ${row.id} AND (${opts.before ?? null}::int IS NULL OR t.seq < ${opts.before ?? null}::int) ORDER BY t.seq DESC LIMIT ${limit}`)).rows as any[];
    return rows.map((r) => ({ seq: r.seq, event: r.event, fromState: r.from_state, toState: r.to_state, actorId: r.actor_id, actorName: r.display_name ?? (r.actor_id === 'system' ? 'System' : null), comment: r.comment ?? null, payload: r.payload ?? null, occurredAt: iso(r.occurred_at)! }));
  }

  // ---------- instance creation ----------

  /** Create the instance in `draft` with its drafter. Idempotent per revision. Runs inside `tx` when given. */
  async createInstance(input: { noteRevisionId: string; billKey: string; versionCode: string; drafterId: string }, actorId: string, requestId?: string, tx: DbOrTx = this.db): Promise<{ instanceId: string; state: WorkflowState; created: boolean }> {
    const existing = await this.instanceByNote(input.noteRevisionId, tx);
    if (existing) return { instanceId: existing.id, state: existing.state, created: false };
    const id = randomUUID();
    const state: WorkflowState = 'draft';
    await tx.execute(sql`INSERT INTO workflow_instances (id, note_revision_id, bill_key, bill_version_id, state, drafter_id, reviewer_id, version)
      VALUES (${id}, ${input.noteRevisionId}, ${input.billKey}, ${`${input.billKey}:${input.versionCode}`}, ${state}, ${input.drafterId}, NULL, 0)`);
    await writeAudit(tx, { actorId, action: 'workflow.instance_create', objectType: 'note_revision', objectId: input.noteRevisionId, after: { instanceId: id, state, drafterId: input.drafterId }, requestId: requestId ?? null });
    return { instanceId: id, state, created: true };
  }

  // ---------- events ----------

  /** Apply one event. 409 when the table refuses it or the expected version is stale. */
  async transition(principal: Principal, noteRevisionId: string, body: TransitionBody, requestId: string): Promise<TransitionOutcome> {
    const message = body.message?.trim() || null;
    const result = await this.db.transaction(async (tx) => {
      const row = await this.instanceByNote(noteRevisionId, tx, true);
      if (!row) throw notFound('Workflow instance');
      const ctx: Ctx = { drafterId: row.drafter_id, reviewerId: row.reviewer_id };
      const allowed = availableEvents(row.state, principal, ctx);
      if (body.expectedVersion !== undefined && body.expectedVersion !== row.version) {
        throw conflict('version_mismatch', `The note changed (version ${row.version}); reload and try again`, { state: row.state, version: row.version, allowed });
      }
      const next = transition(row.state, body.event, principal, ctx, { message });
      if (!next.ok) {
        if (next.reason === 'message_required') throw conflict('message_required', next.message, { state: row.state, version: row.version, allowed });
        await writeAudit(tx, { actorId: principal.userId, action: 'permission.denied', objectType: 'note_revision', objectId: noteRevisionId, after: { action: `workflow.${body.event}`, state: row.state, reason: next.reason }, requestId });
        throw conflict('not_allowed', next.message, { state: row.state, version: row.version, allowed });
      }
      const seq = row.version + 1;
      const updated = await tx.execute(sql`UPDATE workflow_instances SET state = ${next.state}, reviewer_id = ${next.ctx.reviewerId}, version = version + 1, updated_at = now()
        WHERE id = ${row.id} AND version = ${row.version}`);
      if ((updated as { rowCount?: number }).rowCount === 0) throw conflict('version_mismatch', 'Concurrent transition', { state: row.state, version: row.version });
      await tx.execute(sql`INSERT INTO workflow_transitions (instance_id, seq, event, from_state, to_state, actor_id, actor_roles, comment, payload)
        VALUES (${row.id}, ${seq}, ${body.event}, ${row.state}, ${next.state}, ${principal.userId}, ${pgTextArray(principal.roles)}::text[], ${message}, ${'{}'}::jsonb)`);
      const now = new Date().toISOString();
      const versionCode = row.bill_version_id.slice(row.bill_key.length + 1);
      switch (body.event) {
        case 'SUBMIT':
          if (row.state === 'changes_requested') {
            await tx.execute(sql`UPDATE note_change_requests SET resolved_at = now(), resolution = ${message} WHERE note_revision_id = ${noteRevisionId} AND resolved_at IS NULL`);
          }
          break;
        case 'REQUEST_CHANGES':
          await tx.execute(sql`INSERT INTO note_change_requests (id, note_revision_id, requested_by, summary) VALUES (${randomUUID()}, ${noteRevisionId}, ${principal.userId}, ${message})`);
          break;
        case 'APPROVE': {
          const rev = (await tx.execute(sql`SELECT head_version FROM note_revisions WHERE note_revision_id = ${noteRevisionId} FOR UPDATE`)).rows[0] as { head_version: number } | undefined;
          if (!rev) throw notFound('Note revision');
          await tx.execute(sql`UPDATE note_revisions SET approved_document_version = ${rev.head_version}, updated_at = now() WHERE note_revision_id = ${noteRevisionId}`);
          await tx.execute(sql`UPDATE note_documents SET label = COALESCE(label, 'Approved') WHERE note_revision_id = ${noteRevisionId} AND version = ${rev.head_version}`);
          await emitEvent(tx, 'note.approved', { instanceId: row.id, noteRevisionId, billKey: row.bill_key, versionCode, approvedVersion: rev.head_version, approvedAt: now, approvedBy: principal.userId });
          break;
        }
        case 'PUBLISH': {
          const rev = (await tx.execute(sql`SELECT note_id, approved_document_version, head_version FROM note_revisions WHERE note_revision_id = ${noteRevisionId} FOR UPDATE`)).rows[0] as { note_id: string; approved_document_version: number | null; head_version: number } | undefined;
          if (!rev) throw notFound('Note revision');
          const publishedVersion = rev.approved_document_version ?? rev.head_version;
          await tx.execute(sql`UPDATE note_revisions SET published_at = ${now}::timestamptz, published_by = ${principal.userId}, published_version = ${publishedVersion}, updated_at = now() WHERE note_revision_id = ${noteRevisionId}`);
          await writeAudit(tx, { actorId: principal.userId, action: 'note.publish', objectType: 'note_revision', objectId: noteRevisionId, after: { publishedVersion, publishedAt: now }, requestId });
          await emitEvent(tx, 'note.published', { instanceId: row.id, noteId: rev.note_id, noteRevisionId, billKey: row.bill_key, versionCode, publishedVersion, publishedAt: now, publishedBy: principal.userId });
          break;
        }
      }
      await writeAudit(tx, { actorId: principal.userId, action: `workflow.${body.event.toLowerCase()}`, objectType: 'note_revision', objectId: noteRevisionId, before: { state: row.state, version: row.version }, after: { state: next.state, version: seq, message }, requestId });
      await emitEvent(tx, 'note.transitioned', { instanceId: row.id, noteRevisionId, billKey: row.bill_key, seq, event: body.event, from: row.state, to: next.state, actorId: principal.userId, comment: message, occurredAt: now, drafterId: next.ctx.drafterId, reviewerId: next.ctx.reviewerId });
      return { instanceId: row.id, state: next.state, version: seq, seq };
    });
    this.app.bus.kick();
    return result;
  }
}
