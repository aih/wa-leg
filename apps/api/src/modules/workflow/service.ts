// Workflow module: one machine instance per note revision, evaluated with the pure `step()` from
// @wa-leg/workflow-machine and persisted as a snapshot. Every transition writes the instance, an append-only
// transition row, assignment rows, an audit row and outbox events in one transaction.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  BUTTON_EVENTS,
  EVENT_LABELS,
  EVENT_TYPES,
  MACHINE_VERSION,
  NotAllowedError,
  availableEvents,
  drafterStatus,
  initialSnapshot,
  isFinal,
  persist,
  reviewerStatus,
  step,
  type Ctx,
  type Ev,
  type EventType,
  type ExecStep,
  type WorkflowState,
} from '@wa-leg/workflow-machine';
import type { Db, DbOrTx } from '../../db/client.js';
import { writeAudit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/outbox.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { internalCall } from '../../lib/internal.js';
import { pgTextArray } from '../../lib/sql.js';
import { SYSTEM_PRINCIPAL, toActor, hasRole, type Principal } from '../identity/index.js';
import { dueBand, hearingDueAt, statutoryDueAt, times, type DeadlineKind, type DueBand } from './deadlines.js';

export interface InstanceRow {
  id: string;
  note_revision_id: string;
  bill_key: string;
  bill_version_id: string;
  state: WorkflowState;
  snapshot: { value: unknown; context: Ctx };
  drafter_id: string | null;
  reviewer_id: string | null;
  exec_index: number;
  version: number;
  superseded_by: string | null;
  duplicated_from: string | null;
  requested_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface DeadlineView {
  kind: DeadlineKind;
  dueAt: string;
  warnAt: string;
  band: DueBand;
  breached: boolean;
}

export interface WorkflowView {
  instanceId: string;
  noteRevisionId: string;
  state: WorkflowState;
  version: number;
  drafterStatus: string;
  reviewerStatus: string;
  drafterId: string | null;
  reviewerId: string | null;
  execChain: ExecStep[];
  execIndex: number;
  availableEvents: { type: EventType; label: string }[];
  deadlines: DeadlineView[];
  effectiveDueAt: string | null;
  supersededBy: string | null;
  duplicatedFrom: string | null;
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

export interface AssignmentRow {
  instanceId: string;
  noteRevisionId: string;
  billKey: string;
  versionCode: string;
  versionLabel: string;
  title: string | null;
  kind: 'note' | 'estimate';
  role: 'drafter' | 'reviewer' | 'exec';
  position: number;
  /** True for an unclaimed review any editor may take. */
  pool: boolean;
  status: string;
  state: WorkflowState;
  priority: string;
  dueAt: string | null;
  effectiveDueAt: string | null;
  band: DueBand;
  nextHearingAt: string | null;
  assignedAt: string;
  updatedAt: string;
  counterpart: { userId: string; displayName?: string } | null;
  supersededBy: string | null;
  confidential: boolean;
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());

/** Summary fields the workflow reads from the notes API. */
interface NoteSummaryLike {
  noteRevisionId: string;
  billKey: string;
  versionCode: string;
  versionLabel: string;
  billTitle?: string;
  kind: 'note' | 'estimate';
  priority: string;
  confidential: boolean;
  nextHearingAt?: string | null;
  drafter: { userId: string; displayName?: string } | null;
  reviewer: { userId: string; displayName?: string } | null;
  updatedAt: string;
}

export class WorkflowService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly db: Db,
  ) {}

  private get cfg() {
    return this.app.config;
  }

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

  async deadlines(instanceId: string, tx: DbOrTx = this.db): Promise<DeadlineView[]> {
    const rows = (await tx.execute(sql`SELECT kind, due_at, warn_at, breached_at FROM workflow_deadlines WHERE instance_id = ${instanceId} AND cancelled_at IS NULL ORDER BY due_at`)).rows as any[];
    return rows.map((r) => ({ kind: r.kind, dueAt: iso(r.due_at)!, warnAt: iso(r.warn_at)!, band: dueBand(iso(r.due_at)), breached: !!r.breached_at }));
  }

  async view(noteRevisionId: string, principal: Principal): Promise<WorkflowView> {
    const row = await this.requireInstance(noteRevisionId);
    return this.toView(row, principal, await this.deadlines(row.id));
  }

  private async toView(row: InstanceRow, principal: Principal, deadlines: DeadlineView[]): Promise<WorkflowView> {
    const actor = toActor(principal);
    const ctx = row.snapshot.context;
    const events = availableEvents(row.snapshot, actor, BUTTON_EVENTS).map((type) => ({ type, label: EVENT_LABELS[type] ?? type }));
    const editable = (() => {
      if (['todo', 'in_progress', 'changes_requested'].includes(row.state)) return ctx.drafterId === principal.userId;
      if (row.state === 'review.active') return this.cfg.REVIEWER_EDIT && ctx.reviewerId === principal.userId;
      if (row.state === 'exec_review.active') return ctx.execChain[ctx.execIndex]?.userId === principal.userId;
      return false;
    })();
    const superseded = row.superseded_by ? ((await this.db.execute(sql`SELECT note_revision_id FROM workflow_instances WHERE id = ${row.superseded_by}`)).rows[0] as any)?.note_revision_id ?? null : null;
    const duplicated = row.duplicated_from ? ((await this.db.execute(sql`SELECT note_revision_id FROM workflow_instances WHERE id = ${row.duplicated_from}`)).rows[0] as any)?.note_revision_id ?? null : null;
    return {
      instanceId: row.id,
      noteRevisionId: row.note_revision_id,
      state: row.state,
      version: row.version,
      drafterStatus: drafterStatus(row.state),
      reviewerStatus: reviewerStatus(row.state),
      drafterId: ctx.drafterId,
      reviewerId: ctx.reviewerId,
      execChain: ctx.execChain,
      execIndex: ctx.execIndex,
      availableEvents: events,
      deadlines,
      effectiveDueAt: deadlines.map((d) => d.dueAt).sort()[0] ?? null,
      supersededBy: superseded,
      duplicatedFrom: duplicated,
      editable,
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

  async createInstance(
    input: { noteRevisionId: string; billKey: string; versionCode: string; drafterId?: string | null; reviewerId?: string | null; requestedAt?: string | null; hearingAt?: string | null; execChain?: ExecStep[]; duplicatedFrom?: string | null; dueAt?: string | null },
    actorId: string,
    requestId?: string,
  ): Promise<{ instanceId: string; state: WorkflowState; created: boolean }> {
    const existing = await this.instanceByNote(input.noteRevisionId);
    if (existing) return { instanceId: existing.id, state: existing.state, created: false };
    const id = randomUUID();
    const billVersionId = `${input.billKey}:${input.versionCode}`;
    const snap = initialSnapshot({ noteRevisionId: input.noteRevisionId, billVersionId, drafterId: input.drafterId ?? null, reviewerId: input.reviewerId ?? null, execChain: (input.execChain ?? []).map((s) => ({ ...s, doneAt: null })), execIndex: 0 });
    const persisted = persist(snap);
    const state = 'todo' as WorkflowState;
    const requestedAt = input.requestedAt ? new Date(input.requestedAt) : new Date();
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO workflow_instances (id, note_revision_id, bill_key, bill_version_id, machine_version, state, snapshot, drafter_id, reviewer_id, exec_index, version, duplicated_from, requested_at)
        VALUES (${id}, ${input.noteRevisionId}, ${input.billKey}, ${billVersionId}, ${MACHINE_VERSION}, ${state}, ${JSON.stringify(persisted)}::jsonb, ${input.drafterId ?? null}, ${input.reviewerId ?? null}, 0, 0, ${input.duplicatedFrom ?? null}, ${requestedAt.toISOString()}::timestamptz)`);
      if (input.drafterId) {
        const aid = await this.insertAssignment(tx, id, 'drafter', 0, input.drafterId, actorId, input.dueAt ?? null);
        await emitEvent(tx, 'note.assigned', { instanceId: id, noteRevisionId: input.noteRevisionId, role: 'drafter', assigneeId: input.drafterId, previousAssigneeId: null, dueAt: input.dueAt ?? null, assignedBy: actorId });
        if (input.dueAt) await this.insertDeadline(tx, id, 'role_due', new Date(input.dueAt), aid);
      }
      for (const [i, s] of (input.execChain ?? []).entries()) await this.insertAssignment(tx, id, 'exec', i, s.userId, actorId, s.dueAt ?? null);
      await this.insertDeadline(tx, id, 'statutory_72h', statutoryDueAt(requestedAt, this.cfg));
      if (input.hearingAt) await this.insertDeadline(tx, id, 'hearing_minus_4h', hearingDueAt(new Date(input.hearingAt), this.cfg));
      await writeAudit(tx, { actorId, action: 'workflow.instance_create', objectType: 'note_revision', objectId: input.noteRevisionId, after: { instanceId: id, state, drafterId: input.drafterId ?? null, duplicatedFrom: input.duplicatedFrom ?? null }, requestId: requestId ?? null });
    });
    this.touchQueues();
    this.app.bus.kick();
    return { instanceId: id, state, created: true };
  }

  private async insertAssignment(tx: DbOrTx, instanceId: string, role: 'drafter' | 'reviewer' | 'exec', position: number, assigneeId: string, assignedBy: string, dueAt: string | null): Promise<string> {
    const id = randomUUID();
    await tx.execute(sql`UPDATE workflow_assignments SET status = 'reassigned', completed_at = now() WHERE instance_id = ${instanceId} AND role = ${role} AND position = ${position} AND status = 'active'`);
    await tx.execute(sql`INSERT INTO workflow_assignments (id, instance_id, role, position, assignee_id, status, due_at, assigned_by) VALUES (${id}, ${instanceId}, ${role}, ${position}, ${assigneeId}, 'active', ${dueAt}::timestamptz, ${assignedBy})`);
    return id;
  }

  private async insertDeadline(tx: DbOrTx, instanceId: string, kind: DeadlineKind, dueAt: Date, assignmentId: string | null = null): Promise<void> {
    const t = times(kind, dueAt);
    await tx.execute(sql`INSERT INTO workflow_deadlines (id, instance_id, kind, assignment_id, due_at, warn_at, warn_final_at)
      VALUES (${randomUUID()}, ${instanceId}, ${kind}, ${assignmentId}, ${t.dueAt.toISOString()}::timestamptz, ${t.warnAt.toISOString()}::timestamptz, ${t.warnFinalAt.toISOString()}::timestamptz)`);
  }

  // ---------- transitions ----------

  /** Apply one machine event. 409 when the guard refuses it or the expected version is stale. */
  async apply(noteRevisionId: string, ev: Ev, opts: { expectedVersion?: number; requestId?: string } = {}): Promise<{ instanceId: string; state: WorkflowState; version: number; seq: number }> {
    const result = await this.db.transaction(async (tx) => {
      const row = await this.instanceByNote(noteRevisionId, tx, true);
      if (!row) throw notFound('Workflow instance');
      if (opts.expectedVersion !== undefined && opts.expectedVersion !== row.version) {
        throw conflict('version_mismatch', `The note changed (version ${row.version}); reload and try again`, { state: row.state, version: row.version, allowed: availableEvents(row.snapshot, ev.actor, EVENT_TYPES) });
      }
      let next;
      try {
        next = step(row.snapshot, ev);
      } catch (err) {
        if (err instanceof NotAllowedError) {
          await writeAudit(tx, { actorId: ev.actor.userId, action: 'permission.denied', objectType: 'note_revision', objectId: noteRevisionId, after: { action: `workflow.${ev.type}`, state: row.state }, requestId: opts.requestId ?? null });
          throw conflict('not_allowed', err.message, { state: row.state, version: row.version, allowed: availableEvents(row.snapshot, ev.actor, EVENT_TYPES) });
        }
        throw err;
      }
      const persisted = persist(next.snapshot);
      const ctx = next.context;
      const seq = row.version + 1;
      const updated = await tx.execute(sql`UPDATE workflow_instances SET snapshot = ${JSON.stringify(persisted)}::jsonb, state = ${next.state}, drafter_id = ${ctx.drafterId}, reviewer_id = ${ctx.reviewerId}, exec_index = ${ctx.execIndex},
        version = version + 1, updated_at = now() WHERE id = ${row.id} AND version = ${row.version}`);
      if ((updated as { rowCount?: number }).rowCount === 0) throw conflict('version_mismatch', 'Concurrent transition', { state: row.state, version: row.version });
      const { actor, type, ...rest } = ev as Ev & Record<string, unknown>;
      const comment = typeof (rest as { comment?: unknown }).comment === 'string' ? ((rest as { comment: string }).comment ?? null) : null;
      delete (rest as { comment?: unknown }).comment;
      await tx.execute(sql`INSERT INTO workflow_transitions (instance_id, seq, event, from_state, to_state, actor_id, actor_roles, comment, payload)
        VALUES (${row.id}, ${seq}, ${type}, ${row.state}, ${next.state}, ${actor.userId}, ${pgTextArray(actor.roles)}::text[], ${comment}, ${JSON.stringify(rest)}::jsonb)`);
      await this.syncAssignments(tx, row, ctx, next.state, ev);
      if (isFinal(next.state)) await tx.execute(sql`UPDATE workflow_deadlines SET cancelled_at = now() WHERE instance_id = ${row.id} AND cancelled_at IS NULL`);
      await writeAudit(tx, { actorId: actor.userId, action: `workflow.${type.toLowerCase()}`, objectType: 'note_revision', objectId: noteRevisionId, before: { state: row.state, version: row.version }, after: { state: next.state, version: seq, comment }, requestId: opts.requestId ?? null });
      const notify = next.actions.filter((a) => a.type === 'notify').map((a) => (a.params as { to: string }).to);
      await emitEvent(tx, 'note.transitioned', { instanceId: row.id, noteRevisionId, billKey: row.bill_key, seq, event: type, from: row.state, to: next.state, actorId: actor.userId, comment, occurredAt: new Date().toISOString(), notify, drafterId: ctx.drafterId, reviewerId: ctx.reviewerId, execChain: ctx.execChain, execIndex: ctx.execIndex });
      for (const a of next.actions) {
        if (a.type !== 'emit') continue;
        const t = (a.params as { type: string }).type;
        if (t === 'note.approved') await emitEvent(tx, 'note.approved', { instanceId: row.id, noteRevisionId, billKey: row.bill_key, billVersionId: row.bill_version_id, versionCode: row.bill_version_id.split(':').pop(), approvedAt: new Date().toISOString(), approvedBy: actor.userId });
        else if (t === 'note.superseded') await emitEvent(tx, 'note.superseded', { instanceId: row.id, noteRevisionId, newNoteRevisionId: (rest as { newNoteRevisionId?: string }).newNoteRevisionId ?? null, drafterId: ctx.drafterId, reviewerId: ctx.reviewerId });
        else if (t === 'note.assigned') {
          const role = type === 'ASSIGN_DRAFTER' ? 'drafter' : (rest as { role?: string }).role ?? 'drafter';
          const assigneeId = role === 'drafter' ? ctx.drafterId : role === 'reviewer' ? ctx.reviewerId : ctx.execChain[(rest as { position?: number }).position ?? 0]?.userId;
          const previous = role === 'drafter' ? row.drafter_id : role === 'reviewer' ? row.reviewer_id : row.snapshot.context.execChain[(rest as { position?: number }).position ?? 0]?.userId ?? null;
          await emitEvent(tx, 'note.assigned', { instanceId: row.id, noteRevisionId, role, assigneeId, previousAssigneeId: previous ?? null, dueAt: (rest as { dueAt?: string }).dueAt ?? null, assignedBy: actor.userId });
        }
      }
      return { instanceId: row.id, state: next.state, version: seq, seq };
    });
    this.touchQueues();
    this.app.bus.kick();
    return result;
  }

  /** Bring assignment rows in line with the new context. */
  private async syncAssignments(tx: DbOrTx, before: InstanceRow, ctx: Ctx, state: WorkflowState, ev: Ev): Promise<void> {
    const actorId = ev.actor.userId;
    if (ctx.drafterId !== before.drafter_id && ctx.drafterId) await this.insertAssignment(tx, before.id, 'drafter', 0, ctx.drafterId, actorId, (ev as { dueAt?: string }).dueAt ?? null);
    if (ctx.reviewerId !== before.reviewer_id && ctx.reviewerId) await this.insertAssignment(tx, before.id, 'reviewer', 0, ctx.reviewerId, actorId, null);
    const prevChain = before.snapshot.context.execChain;
    if (ev.type === 'SET_EXEC_CHAIN' || ev.type === 'REASSIGN') {
      for (const [i, s] of ctx.execChain.entries()) {
        if (prevChain[i]?.userId !== s.userId || ev.type === 'SET_EXEC_CHAIN') await this.insertAssignment(tx, before.id, 'exec', i, s.userId, actorId, s.dueAt ?? null);
      }
      if (ctx.execChain.length < prevChain.length) await tx.execute(sql`UPDATE workflow_assignments SET status = 'cancelled', completed_at = now() WHERE instance_id = ${before.id} AND role = 'exec' AND position >= ${ctx.execChain.length} AND status = 'active'`);
    }
    for (const [i, s] of ctx.execChain.entries()) {
      if (s.doneAt && !prevChain[i]?.doneAt) await tx.execute(sql`UPDATE workflow_assignments SET status = 'done', completed_at = now() WHERE instance_id = ${before.id} AND role = 'exec' AND position = ${i} AND status = 'active'`);
    }
    if (ev.type === 'EXEC_RETURN') await tx.execute(sql`UPDATE workflow_assignments SET status = 'active', completed_at = NULL WHERE instance_id = ${before.id} AND role = 'exec' AND status = 'done'`);
    if (isFinal(state)) {
      const status = state === 'approved' ? 'done' : 'cancelled';
      await tx.execute(sql`UPDATE workflow_assignments SET status = ${status}, completed_at = now() WHERE instance_id = ${before.id} AND status = 'active'`);
    }
  }

  // ---------- commands wrapping events ----------

  async transition(principal: Principal, noteRevisionId: string, body: { event: EventType; comment?: string; expectedVersion?: number }, requestId: string) {
    const actor = toActor(principal);
    const ev = { type: body.event, actor, comment: body.comment ?? '' } as Ev;
    if (['REQUEST_CHANGES', 'EXEC_RETURN', 'CANCEL'].includes(body.event) && !body.comment?.trim()) throw conflict('comment_required', `${EVENT_LABELS[body.event]} needs a comment`);
    if (!(BUTTON_EVENTS as readonly string[]).includes(body.event)) throw forbidden('Administrative events use the assignment endpoints');
    if (body.event === 'SUBMIT_FOR_REVIEW') await this.settleChangeRequest(principal, noteRevisionId, body.comment);
    const res = await this.apply(noteRevisionId, ev, { expectedVersion: body.expectedVersion, requestId });
    if (body.event === 'REQUEST_CHANGES' || body.event === 'EXEC_RETURN') {
      // The notes module keeps the itemised request the drafter works through.
      await internalCall(this.app, `/notes/${noteRevisionId}/change-requests`, { method: 'POST', as: principal, body: { transitionSeq: res.seq, event: body.event, summary: body.comment ?? '' } });
    }
    return res;
  }

  /** Resubmitting needs every change request item addressed; a request left open with no open items is closed with the submit comment. */
  private async settleChangeRequest(principal: Principal, noteRevisionId: string, comment: string | undefined): Promise<void> {
    const open = (await internalCall<{ id: string; status: string; openItems: number }[]>(this.app, `/notes/${noteRevisionId}/change-requests`)).find((c) => c.status === 'open');
    if (!open) return;
    if (open.openItems > 0) throw conflict('change_request_open', `${open.openItems} change request item(s) are still open; address each one in the Changes tab before resubmitting`, { changeRequestId: open.id, openItems: open.openItems });
    await internalCall(this.app, `/notes/${noteRevisionId}/change-requests/${open.id}/close`, { method: 'POST', as: principal, body: { resolution: comment?.trim() || 'Resubmitted for review' } });
  }

  async assign(principal: Principal, noteRevisionId: string, body: { role: 'drafter' | 'reviewer' | 'exec'; userId: string; position?: number; dueAt?: string }, requestId: string) {
    const actor = toActor(principal);
    const row = await this.requireInstance(noteRevisionId);
    const usesAssignDrafter = body.role === 'drafter' && ['todo', 'in_progress', 'changes_requested'].includes(row.state);
    const ev: Ev = usesAssignDrafter ? { type: 'ASSIGN_DRAFTER', actor, userId: body.userId, dueAt: body.dueAt } : { type: 'REASSIGN', actor, role: body.role, userId: body.userId, position: body.position };
    const res = await this.apply(noteRevisionId, ev, { requestId });
    if (body.dueAt) {
      await this.db.transaction(async (tx) => {
        const a = (await tx.execute(sql`SELECT id FROM workflow_assignments WHERE instance_id = ${row.id} AND role = ${body.role} AND position = ${body.position ?? 0} AND status = 'active'`)).rows[0] as any;
        await tx.execute(sql`UPDATE workflow_deadlines SET cancelled_at = now() WHERE instance_id = ${row.id} AND kind = 'role_due' AND assignment_id = ${a?.id ?? null} AND cancelled_at IS NULL`);
        await this.insertDeadline(tx, row.id, 'role_due', new Date(body.dueAt!), a?.id ?? null);
        if (a) await tx.execute(sql`UPDATE workflow_assignments SET due_at = ${body.dueAt}::timestamptz WHERE id = ${a.id}`);
      });
      this.touchQueues();
    }
    return res;
  }

  async setExecChain(principal: Principal, noteRevisionId: string, chain: { userId: string; division?: string; dueAt?: string | null }[], requestId: string) {
    const actor = toActor(principal);
    const steps: ExecStep[] = chain.map((s) => ({ userId: s.userId, division: s.division ?? '', dueAt: s.dueAt ?? null, doneAt: null }));
    return this.apply(noteRevisionId, { type: 'SET_EXEC_CHAIN', actor, chain: steps }, { requestId });
  }

  /** Supersede the open instance of `previousRevisionId` and create the new revision's instance with the same people. */
  async supersede(previousRevisionId: string, newRevisionId: string, billKey: string, versionCode: string, actorId: string, requestId?: string): Promise<{ instanceId: string; state: WorkflowState }> {
    const prev = await this.instanceByNote(previousRevisionId);
    let drafterId: string | null = null;
    let execChain: ExecStep[] = [];
    let requestedAt: string | null = null;
    if (prev) {
      drafterId = prev.snapshot.context.drafterId;
      execChain = prev.snapshot.context.execChain;
      requestedAt = iso(prev.requested_at);
      if (!isFinal(prev.state)) {
        await this.apply(previousRevisionId, { type: 'SUPERSEDE', actor: toActor(SYSTEM_PRINCIPAL), newBillVersionId: `${billKey}:${versionCode}`, newNoteRevisionId: newRevisionId } as Ev, { requestId });
      }
    }
    const hearingAt = await this.nextHearing(billKey);
    const created = await this.createInstance({ noteRevisionId: newRevisionId, billKey, versionCode, drafterId, execChain, requestedAt, hearingAt, duplicatedFrom: prev?.id ?? null }, actorId, requestId);
    if (prev) await this.db.execute(sql`UPDATE workflow_instances SET superseded_by = ${created.instanceId} WHERE id = ${prev.id}`);
    return created;
  }

  /** Duplicate the task: a fresh instance in `todo` for another revision with the same assignments. */
  async duplicate(principal: Principal, fromRevisionId: string, newRevisionId: string, requestId: string) {
    const prev = await this.requireInstance(fromRevisionId);
    const [, biennium, id, versionCode] = prev.bill_version_id.split(':');
    return this.createInstance({ noteRevisionId: newRevisionId, billKey: `WA:${biennium}:${id}`, versionCode: versionCode ?? '', drafterId: prev.snapshot.context.drafterId, execChain: prev.snapshot.context.execChain, requestedAt: iso(prev.requested_at), duplicatedFrom: prev.id }, principal.userId, requestId);
  }

  // ---------- automatic reactions ----------

  /** The drafter's first save starts the task. */
  async autoStart(noteRevisionId: string, actorId: string): Promise<void> {
    const row = await this.instanceByNote(noteRevisionId);
    if (!row || row.state !== 'todo' || row.drafter_id !== actorId) return;
    try {
      await this.apply(noteRevisionId, { type: 'START', actor: { userId: actorId, roles: ['drafter'] } });
    } catch (err) {
      this.app.log.warn({ err, noteRevisionId }, 'auto START failed');
    }
  }

  private async nextHearing(billKey: string): Promise<string | null> {
    const [, biennium, id] = billKey.split(':');
    try {
      const hearings = await internalCall<{ hearingAt: string; cancelled: boolean }[]>(this.app, `/bills/${biennium}/${id}/hearings`);
      return hearings.filter((h) => !h.cancelled && new Date(h.hearingAt) > new Date()).map((h) => h.hearingAt).sort()[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Recompute `hearing_minus_4h` for every open instance on the bill. */
  async rescheduleHearingDeadlines(billKey: string): Promise<number> {
    const hearingAt = await this.nextHearing(billKey);
    const rows = (await this.db.execute(sql`SELECT id FROM workflow_instances WHERE bill_key = ${billKey} AND state NOT IN ('approved', 'cancelled', 'superseded')`)).rows as { id: string }[];
    await this.db.transaction(async (tx) => {
      for (const r of rows) {
        await tx.execute(sql`UPDATE workflow_deadlines SET cancelled_at = now() WHERE instance_id = ${r.id} AND kind = 'hearing_minus_4h' AND cancelled_at IS NULL`);
        if (hearingAt) await this.insertDeadline(tx, r.id, 'hearing_minus_4h', hearingDueAt(new Date(hearingAt), this.cfg));
      }
    });
    this.touchQueues();
    return rows.length;
  }

  /** Deadline poller: fire due_soon at each warn time and overdue at the due time. Safe across replicas (SKIP LOCKED). */
  async pollDeadlines(now = new Date()): Promise<{ warned: number; overdue: number }> {
    const at = now.toISOString();
    let warned = 0;
    let overdue = 0;
    const managerIds = await this.managerIds();
    for (const [column, stamp] of [
      ['warn_at', 'warned_at'],
      ['warn_final_at', 'warned_final_at'],
    ] as const) {
      const rows = (await this.db.execute(sql`UPDATE workflow_deadlines SET ${sql.raw(stamp)} = now() WHERE id IN (
          SELECT id FROM workflow_deadlines WHERE ${sql.raw(column)} <= ${at}::timestamptz AND ${sql.raw(stamp)} IS NULL AND breached_at IS NULL AND cancelled_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 100)
        RETURNING id, instance_id, kind, due_at`)).rows as any[];
      for (const d of rows) {
        // A warn time already past its due time is folded into the overdue notice.
        if (new Date(d.due_at) <= now) continue;
        await this.emitDeadline('note.due_soon', d, managerIds);
        warned++;
      }
    }
    const breached = (await this.db.execute(sql`UPDATE workflow_deadlines SET breached_at = now() WHERE id IN (
        SELECT id FROM workflow_deadlines WHERE due_at <= ${at}::timestamptz AND breached_at IS NULL AND cancelled_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 100)
      RETURNING id, instance_id, kind, due_at`)).rows as any[];
    for (const d of breached) {
      await this.emitDeadline('note.overdue', d, managerIds);
      overdue++;
    }
    if (warned || overdue) {
      this.touchQueues();
      this.app.bus.kick();
    }
    return { warned, overdue };
  }

  private async emitDeadline(type: 'note.due_soon' | 'note.overdue', d: { id: string; instance_id: string; kind: DeadlineKind; due_at: Date | string }, managerIds: string[]): Promise<void> {
    const inst = (await this.db.execute(sql`SELECT note_revision_id, bill_key, state, drafter_id, reviewer_id, exec_index, snapshot FROM workflow_instances WHERE id = ${d.instance_id}`)).rows[0] as any;
    if (!inst || isFinal(inst.state)) return;
    const assignees = (await this.db.execute(sql`SELECT assignee_id, role, position FROM workflow_assignments WHERE instance_id = ${d.instance_id} AND status = 'active'`)).rows as { assignee_id: string; role: string; position: number }[];
    // The people who need to act now: the drafter while drafting, the reviewer in review, the current exec in exec review.
    const acting = assignees.filter((a) => (['todo', 'in_progress', 'changes_requested'].includes(inst.state) ? a.role === 'drafter' : inst.state.startsWith('review') ? a.role === 'reviewer' || (inst.reviewer_id === null && a.role === 'drafter') : a.role === 'exec' && a.position === inst.exec_index)).map((a) => a.assignee_id);
    const assigneeIds = Array.from(new Set(acting.length ? acting : assignees.map((a) => a.assignee_id)));
    await emitEvent(this.db, type, { instanceId: d.instance_id, noteRevisionId: inst.note_revision_id, billKey: inst.bill_key, kind: d.kind, dueAt: iso(d.due_at), state: inst.state, assigneeIds, managerIds: type === 'note.overdue' ? managerIds : [], deadlineId: d.id });
  }

  private async managerIds(): Promise<string[]> {
    try {
      const users = await internalCall<{ userId: string }[]>(this.app, '/users?role=manager');
      return users.map((u) => u.userId);
    } catch {
      return [];
    }
  }

  // ---------- queues ----------

  /**
   * Queue responses are cached for a few seconds per caller and filter; any workflow write invalidates them.
   * Misses are single-flight (concurrent callers share one computation) and a fresh-enough stale entry is served
   * while the refresh runs, so a burst never recomputes the queue more than once.
   */
  private queueVersion = 0;
  private readonly queueCache = new Map<string, { at: number; version: number; rows: AssignmentRow[] | null; pending: Promise<AssignmentRow[]> | null }>();
  private touchQueues(): void {
    this.queueVersion++;
    if (this.queueCache.size > 500) this.queueCache.clear();
  }

  async assignments(principal: Principal, filter: { assignee?: string; role?: 'drafter' | 'reviewer' | 'exec'; status?: string; state?: string; dueBefore?: string; limit?: number; all?: boolean }): Promise<AssignmentRow[]> {
    const key = `${principal.userId}|${JSON.stringify(filter)}`;
    const now = Date.now();
    const hit = this.queueCache.get(key);
    const current = !!hit && hit.version === this.queueVersion;
    if (hit && current && hit.rows && now - hit.at < 5_000) return hit.rows;
    if (hit?.pending) {
      // A refresh is running: serve the previous rows if they are still current, else wait for it.
      if (current && hit.rows && now - hit.at < 30_000) return hit.rows;
      return hit.pending;
    }
    const version = this.queueVersion;
    const pending = this.assignmentsUncached(principal, filter)
      .then((rows) => {
        this.queueCache.set(key, { at: Date.now(), version, rows, pending: null });
        return rows;
      })
      .catch((err) => {
        this.queueCache.delete(key);
        throw err;
      });
    this.queueCache.set(key, { at: hit?.at ?? 0, version, rows: current ? (hit?.rows ?? null) : null, pending });
    if (current && hit?.rows && now - hit.at < 30_000) return hit.rows;
    return pending;
  }

  private async assignmentsUncached(principal: Principal, filter: { assignee?: string; role?: 'drafter' | 'reviewer' | 'exec'; status?: string; state?: string; dueBefore?: string; limit?: number; all?: boolean }): Promise<AssignmentRow[]> {
    const me = principal.userId;
    let assignee = filter.assignee === 'me' || !filter.assignee ? me : filter.assignee;
    if (filter.all) assignee = '';
    if (assignee !== me && !hasRole(principal, 'admin', 'manager', 'reviewer', 'approver')) throw forbidden('Only assigners may list other users’ assignments');
    const limit = Math.min(filter.limit ?? 200, 500);
    const rows = (await this.db.execute(sql`SELECT a.id AS assignment_id, a.role, a.position, a.assignee_id, a.due_at, a.assigned_at, i.*,
          (SELECT min(d.due_at) FROM workflow_deadlines d WHERE d.instance_id = i.id AND d.cancelled_at IS NULL) AS earliest_due,
          sup.note_revision_id AS superseded_note
        FROM workflow_assignments a JOIN workflow_instances i ON i.id = a.instance_id LEFT JOIN workflow_instances sup ON sup.id = i.superseded_by
        WHERE (a.status = 'active' OR (a.status = 'done' AND i.state = 'approved' AND i.updated_at > now() - interval '14 days')) AND (${assignee} = '' OR a.assignee_id = ${assignee}) AND (${filter.role ?? null}::text IS NULL OR a.role = ${filter.role ?? null})
          AND (${filter.state ?? null}::text IS NULL OR i.state = ${filter.state ?? null})
        ORDER BY i.updated_at DESC LIMIT ${limit}`)).rows as any[];
    // Unclaimed reviews are a pool any editor may take; exec steps show only for the current step.
    const pool: any[] = hasRole(principal, 'reviewer', 'approver', 'manager', 'admin') && (!filter.role || filter.role === 'reviewer') && (assignee === me || assignee === '')
      ? ((await this.db.execute(sql`SELECT NULL AS assignment_id, 'reviewer' AS role, 0 AS position, NULL AS assignee_id, NULL AS due_at, i.updated_at AS assigned_at, i.*, (SELECT min(d.due_at) FROM workflow_deadlines d WHERE d.instance_id = i.id AND d.cancelled_at IS NULL) AS earliest_due, NULL AS superseded_note FROM workflow_instances i WHERE i.state = 'review.pending' AND i.reviewer_id IS NULL ORDER BY i.updated_at DESC LIMIT ${limit}`)).rows as any[])
      : [];
    const out: AssignmentRow[] = [];
    const cache = new Map<string, NoteSummaryLike | null>();
    const summaryOf = async (id: string) => {
      if (!cache.has(id)) {
        try {
          cache.set(id, await internalCall<NoteSummaryLike>(this.app, `/notes/${id}`, { as: principal }));
        } catch {
          cache.set(id, null);
        }
      }
      return cache.get(id) ?? null;
    };
    for (const r of [...rows, ...pool]) {
      if (r.role === 'exec' && r.position !== r.exec_index && !filter.all) continue;
      const s = await summaryOf(r.note_revision_id);
      if (!s) continue; // not visible to the caller
      const dueAt = iso(r.due_at);
      const effective = [dueAt, iso(r.earliest_due)].filter((x): x is string => !!x).sort()[0] ?? null;
      const role = r.role as AssignmentRow['role'];
      const status = role === 'drafter' ? drafterStatus(r.state) : reviewerStatus(r.state);
      if (filter.status && status !== filter.status) continue;
      if (filter.dueBefore && (!effective || effective > filter.dueBefore)) continue;
      const supersededBy = (r.superseded_note as string | null) ?? null;
      out.push({
        instanceId: r.id,
        noteRevisionId: r.note_revision_id,
        billKey: r.bill_key,
        versionCode: s.versionCode,
        versionLabel: s.versionLabel,
        title: s.billTitle ?? null,
        kind: s.kind,
        role,
        position: r.position,
        pool: r.assignee_id === null,
        status,
        state: r.state,
        priority: s.priority,
        dueAt,
        effectiveDueAt: effective,
        band: dueBand(effective),
        nextHearingAt: s.nextHearingAt ?? null,
        assignedAt: iso(r.assigned_at)!,
        updatedAt: iso(r.updated_at)!,
        counterpart: role === 'drafter' ? s.reviewer : s.drafter,
        supersededBy,
        confidential: s.confidential,
      });
    }
    // Soonest effective due first; rows without a deadline last; then most recently updated.
    return out.sort((a, b) => (a.effectiveDueAt ?? '9999').localeCompare(b.effectiveDueAt ?? '9999') || b.updatedAt.localeCompare(a.updatedAt));
  }

  async summary(filter: { state?: string; drafter?: string; reviewer?: string }): Promise<Record<string, number>> {
    const rows = (await this.db.execute(sql`SELECT state, count(*)::int AS n FROM workflow_instances
      WHERE (${filter.state ?? null}::text IS NULL OR state = ${filter.state ?? null}) AND (${filter.drafter ?? null}::text IS NULL OR drafter_id = ${filter.drafter ?? null}) AND (${filter.reviewer ?? null}::text IS NULL OR reviewer_id = ${filter.reviewer ?? null})
      GROUP BY state`)).rows as { state: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = Number(r.n);
    return out;
  }

  /** Bills with a hearing inside the window and no note instance (the trigger for creating a task). */
  async unassignedHearings(withinHours: number): Promise<{ id: string; billKey: string; biennium: string; billId: string; title: string; versionCode: string | null; committee: string; chamber: string | null; kind: string; hearingAt: string; hasNote: boolean }[]> {
    const to = new Date(Date.now() + withinHours * 3_600_000).toISOString();
    const hearings = await internalCall<{ id: string; billKey: string; biennium: string; billId: string; title: string; versionCode: string | null; committee: string; chamber: string | null; kind: string; hearingAt: string }[]>(this.app, `/hearings?to=${encodeURIComponent(to)}`);
    if (hearings.length === 0) return [];
    const keys = Array.from(new Set(hearings.map((h) => h.billKey)));
    const withNotes = new Set(((await this.db.execute(sql`SELECT DISTINCT bill_key FROM workflow_instances WHERE bill_key = ANY(${pgTextArray(keys)}::text[])`)).rows as { bill_key: string }[]).map((r) => r.bill_key));
    return hearings.map((h) => ({ ...h, hasNote: withNotes.has(h.billKey) })).filter((h) => !h.hasNote);
  }
}
