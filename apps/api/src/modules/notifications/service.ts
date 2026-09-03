// Notifications: turn workflow and bill events into inbox rows (one per recipient) and email them.
// Recipients are resolved through the identity and notes APIs; this module owns only `notifications`.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { internalCall } from '../../lib/internal.js';
import { writeAudit } from '../../lib/audit.js';
import type { BusEvent } from '../../lib/outbox.js';
import type { Principal } from '../identity/index.js';
import type { Mailer } from './mailer.js';

export interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  link: string | null;
  createdAt: string;
  readAt: string | null;
  emailedAt: string | null;
}

interface NoteLike {
  noteRevisionId: string;
  billKey: string;
  versionLabel: string;
  billTitle?: string;
  kind: 'note' | 'estimate';
  state: string;
  drafter: { userId: string; displayName?: string } | null;
  reviewer: { userId: string; displayName?: string } | null;
  execChain: { userId: string }[];
  execIndex: number;
}

interface UserLike {
  userId: string;
  displayName: string;
  email: string | null;
  roles: string[];
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());

export class NotificationsService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly db: Db,
    readonly mailer: Mailer,
  ) {}

  // ---------- inbox ----------

  async list(p: Principal, opts: { unread?: boolean; limit?: number } = {}): Promise<NotificationRow[]> {
    const rows = (await this.db.execute(sql`SELECT * FROM notifications WHERE user_id = ${p.userId} AND (${opts.unread ? 1 : 0} = 0 OR read_at IS NULL) ORDER BY read_at IS NULL DESC, created_at DESC LIMIT ${Math.min(opts.limit ?? 100, 500)}`)).rows as any[];
    return rows.map((r) => ({ id: r.id, userId: r.user_id, type: r.type, title: r.title, body: r.body, payload: r.payload ?? {}, link: r.link ?? null, createdAt: iso(r.created_at)!, readAt: iso(r.read_at), emailedAt: iso(r.emailed_at) }));
  }

  async unreadCount(p: Principal): Promise<number> {
    const r = (await this.db.execute(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${p.userId} AND read_at IS NULL`)).rows[0] as { n: number };
    return Number(r?.n ?? 0);
  }

  async markRead(p: Principal, id: string | 'all'): Promise<number> {
    const res = id === 'all'
      ? await this.db.execute(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${p.userId} AND read_at IS NULL`)
      : await this.db.execute(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${p.userId} AND id = ${id} AND read_at IS NULL`);
    return (res as { rowCount?: number }).rowCount ?? 0;
  }

  // ---------- producers ----------

  private async note(id: string): Promise<NoteLike | null> {
    try {
      return await internalCall<NoteLike>(this.app, `/notes/${id}`);
    } catch {
      return null;
    }
  }

  private usersCache: { at: number; rows: UserLike[] } | null = null;
  private async users(): Promise<UserLike[]> {
    if (this.usersCache && Date.now() - this.usersCache.at < 30_000) return this.usersCache.rows;
    try {
      const rows = await internalCall<UserLike[]>(this.app, '/users');
      this.usersCache = { at: Date.now(), rows };
      return rows;
    } catch {
      return this.usersCache?.rows ?? [];
    }
  }

  private async name(userId: string | null | undefined): Promise<string> {
    if (!userId) return 'nobody';
    return (await this.users()).find((u) => u.userId === userId)?.displayName ?? userId;
  }

  private label(n: NoteLike | null, fallback: string): string {
    return n ? `${n.versionLabel} ${n.kind === 'estimate' ? 'estimate' : 'fiscal note'}` : fallback;
  }

  /** Write one inbox row per recipient (idempotent per event, user and type) and email it. */
  async deliver(ev: BusEvent | null, recipients: Iterable<string | null | undefined>, msg: { type: string; title: string; body: string; link?: string | null; payload?: Record<string, unknown>; exclude?: string | null }): Promise<number> {
    const ids = Array.from(new Set(Array.from(recipients).filter((u): u is string => !!u && u !== msg.exclude && u !== 'system')));
    let n = 0;
    for (const userId of ids) {
      const id = randomUUID();
      const inserted = await this.db.execute(sql`INSERT INTO notifications (id, user_id, type, title, body, payload, link, event_id)
        VALUES (${id}, ${userId}, ${msg.type}, ${msg.title}, ${msg.body}, ${JSON.stringify(msg.payload ?? {})}::jsonb, ${msg.link ?? null}, ${ev?.eventId ?? null})
        ON CONFLICT DO NOTHING RETURNING id`);
      if ((inserted.rows ?? []).length === 0) continue;
      n++;
      await writeAudit(this.db, { actorId: 'system', action: 'notification.create', objectType: 'notification', objectId: id, after: { userId, type: msg.type, eventId: ev?.eventId ?? null } });
      const user = (await this.users()).find((u) => u.userId === userId);
      if (user?.email) {
        try {
          const url = `${this.app.config.WEB_ORIGIN}${msg.link ?? '/inbox'}`;
          await this.mailer.send({ to: user.email, subject: `[Fiscal notes] ${msg.title}`, text: `${msg.body}\n\n${url}`, html: `<p>${escape(msg.body)}</p><p><a href="${url}">Open in the workbench</a></p>` });
          await this.db.execute(sql`UPDATE notifications SET emailed_at = now() WHERE id = ${id}`);
        } catch (err) {
          await this.db.execute(sql`UPDATE notifications SET email_error = ${(err as Error).message} WHERE id = ${id}`);
          this.app.log.warn({ err, userId }, 'notification email failed');
        }
      }
    }
    return n;
  }

  // ---------- event handlers ----------

  async onTransitioned(ev: BusEvent): Promise<void> {
    const p = ev.payload as { noteRevisionId: string; event: string; from: string; to: string; actorId: string; comment?: string | null; notify?: string[]; drafterId: string | null; reviewerId: string | null; execChain: { userId: string }[]; execIndex: number };
    const n = await this.note(p.noteRevisionId);
    const label = this.label(n, 'A fiscal note');
    const link = `/notes/${p.noteRevisionId}`;
    const actor = await this.name(p.actorId);
    const editors = (await this.users()).filter((u) => u.roles.includes('reviewer') || u.roles.includes('manager')).map((u) => u.userId);
    const comment = p.comment ? ` Comment: “${p.comment}”` : '';
    switch (p.event) {
      case 'SUBMIT_FOR_REVIEW':
        await this.deliver(ev, p.reviewerId ? [p.reviewerId] : editors, { type: 'note.submitted', title: `${label} is ready for review`, body: `${actor} submitted ${label} for review.${comment}`, link, exclude: p.actorId, payload: p });
        break;
      case 'CLAIM_REVIEW':
        await this.deliver(ev, [p.drafterId], { type: 'note.claimed', title: `${actor} is reviewing ${label}`, body: `${actor} claimed the review of ${label}.`, link, exclude: p.actorId, payload: p });
        break;
      case 'REQUEST_CHANGES':
      case 'EXEC_RETURN':
        await this.deliver(ev, [p.drafterId], { type: 'note.changes_requested', title: `Changes requested on ${label}`, body: `${actor} requested changes on ${label}.${comment}`, link, exclude: p.actorId, payload: p });
        break;
      case 'APPROVE':
      case 'EXEC_DONE':
        if (p.to === 'approved') {
          await this.deliver(ev, [p.drafterId, p.reviewerId, ...p.execChain.map((s) => s.userId)], { type: 'note.approved', title: `${label} approved`, body: `${actor} approved ${label}.${comment}`, link, exclude: p.actorId, payload: p });
        } else {
          const next = p.execChain[p.execIndex]?.userId;
          const stepNo = p.execIndex + 1;
          await this.deliver(ev, [next], { type: 'note.exec_review', title: `Executive review step ${stepNo} of ${p.execChain.length}: ${label}`, body: `${actor} sent ${label} to you for executive review (step ${stepNo} of ${p.execChain.length}).${comment}`, link, exclude: p.actorId, payload: p });
          if (p.event === 'EXEC_DONE') await this.deliver(ev, [p.drafterId, p.reviewerId], { type: 'note.exec_step_done', title: `${label}: executive review step ${stepNo - 1} done`, body: `${actor} completed executive review step ${stepNo - 1} of ${p.execChain.length}; the note moved to step ${stepNo}.`, link, exclude: p.actorId, payload: p });
        }
        break;
      case 'CANCEL':
        await this.deliver(ev, [p.drafterId, p.reviewerId], { type: 'note.cancelled', title: `${label} cancelled`, body: `${actor} cancelled ${label}.${comment}`, link, exclude: p.actorId, payload: p });
        break;
      case 'SUPERSEDE':
        await this.deliver(ev, [p.drafterId, p.reviewerId], { type: 'note.superseded', title: `${label} superseded`, body: `${label} was superseded by a revision for a newer bill version.`, link, payload: p });
        break;
      default:
        break;
    }
  }

  async onAssigned(ev: BusEvent): Promise<void> {
    const p = ev.payload as { noteRevisionId: string; role: string; assigneeId: string | null; previousAssigneeId?: string | null; dueAt?: string | null; assignedBy: string };
    if (!p.assigneeId) return;
    const n = await this.note(p.noteRevisionId);
    const label = this.label(n, 'A fiscal note');
    const by = await this.name(p.assignedBy);
    const due = p.dueAt ? ` Due ${new Date(p.dueAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}.` : '';
    await this.deliver(ev, [p.assigneeId], { type: 'note.assigned', title: `${label} assigned to you as ${p.role}`, body: `${by} assigned you ${label} (${p.role}).${due}`, link: `/notes/${p.noteRevisionId}`, exclude: p.assignedBy === p.assigneeId ? null : p.assignedBy, payload: p });
    if (p.previousAssigneeId && p.previousAssigneeId !== p.assigneeId) {
      await this.deliver(ev, [p.previousAssigneeId], { type: 'note.reassigned', title: `${label} reassigned`, body: `${by} reassigned ${label} (${p.role}) to ${await this.name(p.assigneeId)}.`, link: `/notes/${p.noteRevisionId}`, exclude: p.assignedBy, payload: p });
    }
  }

  async onDeadline(ev: BusEvent): Promise<void> {
    const p = ev.payload as { noteRevisionId: string; kind: string; dueAt: string; assigneeIds: string[]; managerIds?: string[] };
    const n = await this.note(p.noteRevisionId);
    const label = this.label(n, 'A fiscal note');
    const when = new Date(p.dueAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const kind = p.kind === 'statutory_72h' ? 'the 72-hour statutory deadline' : p.kind === 'hearing_minus_4h' ? 'the hearing cutoff (4 hours before the hearing)' : 'the assigned due time';
    if (ev.type === 'note.overdue') {
      await this.deliver(ev, [...p.assigneeIds, ...(p.managerIds ?? [])], { type: 'note.overdue', title: `Overdue: ${label}`, body: `${label} passed ${kind} at ${when}.`, link: `/notes/${p.noteRevisionId}`, payload: p });
    } else {
      const hours = Math.max(0, Math.round((new Date(p.dueAt).getTime() - Date.now()) / 3_600_000));
      await this.deliver(ev, p.assigneeIds, { type: 'note.due_soon', title: `Due in ${hours} h: ${label}`, body: `${label} reaches ${kind} at ${when}.`, link: `/notes/${p.noteRevisionId}`, payload: p });
    }
  }

  /** Bill changes go to the drafters and reviewers of open notes on that bill. */
  async onBillChanged(ev: BusEvent): Promise<void> {
    const p = ev.payload as { billKey: string; versionCode?: string; label?: string; amendmentId?: string; hearingAt?: string; committee?: string };
    let notes: NoteLike[] = [];
    try {
      notes = await internalCall<NoteLike[]>(this.app, `/notes?billKey=${encodeURIComponent(p.billKey)}&size=200`);
    } catch {
      return;
    }
    const open = notes.filter((n) => !['approved', 'cancelled', 'superseded'].includes(n.state));
    if (open.length === 0) return;
    const [, , billId] = p.billKey.split(':');
    const bill = (billId ?? p.billKey).replace(/^([A-Z]+)(\d+)$/, '$1 $2');
    const what =
      ev.type === 'bill.version_added'
        ? { type: 'bill.version_added', title: `New version of ${bill}: ${p.label ?? p.versionCode}`, body: `${p.label ?? p.versionCode} was added to ${bill}. Open your note to create a revision for the new version.` }
        : ev.type === 'bill.amendment_added'
          ? { type: 'bill.amendment_added', title: `New amendment on ${bill}`, body: `Amendment ${p.amendmentId} was added to ${bill}.` }
          : ev.type === 'hearing.cancelled'
            ? { type: 'hearing.cancelled', title: `Hearing cancelled for ${bill}`, body: `The hearing on ${bill} was cancelled.` }
            : { type: ev.type, title: `Hearing ${ev.type === 'hearing.rescheduled' ? 'moved' : 'scheduled'} for ${bill}`, body: `${bill} has a hearing ${p.committee ? `in ${p.committee} ` : ''}at ${p.hearingAt ? new Date(p.hearingAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) : 'a new time'}.` };
    for (const n of open) {
      await this.deliver(ev, [n.drafter?.userId, n.reviewer?.userId], { ...what, link: `/notes/${n.noteRevisionId}`, payload: { ...p, noteRevisionId: n.noteRevisionId } });
    }
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
