import type { FastifyInstance } from 'fastify';
import { WorkflowService } from './service.js';
import { workflowRoutes } from './routes.js';

export { WorkflowService, workflowRoutes };
export * from './deadlines.js';
export type { WorkflowView, AssignmentRow, TransitionRow } from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    workflowSvc: WorkflowService;
  }
}

/** Create the workflow service on the root instance, subscribe to events, and start the deadline poller. */
export function createWorkflow(app: FastifyInstance, opts: { workers: boolean }): WorkflowService {
  const svc = new WorkflowService(app, app.db);
  app.decorate('workflowSvc', svc);
  const bus = app.bus;

  bus.subscribe('workflow:requests', ['fiscal_note.requested'], async (ev) => {
    const p = ev.payload as { noteRevisionId: string; billKey: string; versionCode: string; requestedAt?: string; hearingAt?: string | null; requestedBy?: string; drafterId?: string | null };
    await svc.createInstance({ noteRevisionId: p.noteRevisionId, billKey: p.billKey, versionCode: p.versionCode, drafterId: p.drafterId ?? null, requestedAt: p.requestedAt ?? null, hearingAt: p.hearingAt ?? null }, p.requestedBy ?? 'system', `event:${ev.eventId}`);
  });

  bus.subscribe('workflow:revisions', ['note.revision_created'], async (ev) => {
    const p = ev.payload as { noteRevisionId: string; previousRevisionId?: string | null; billKey: string; versionCode: string; drafterId?: string | null; execChain?: unknown };
    if (p.previousRevisionId) await svc.supersede(p.previousRevisionId, p.noteRevisionId, p.billKey, p.versionCode, 'system', `event:${ev.eventId}`);
    else await svc.createInstance({ noteRevisionId: p.noteRevisionId, billKey: p.billKey, versionCode: p.versionCode, drafterId: p.drafterId ?? null }, 'system', `event:${ev.eventId}`);
  });

  bus.subscribe('workflow:hearings', ['hearing.scheduled', 'hearing.rescheduled', 'hearing.cancelled'], async (ev) => {
    const p = ev.payload as { billKey: string };
    await svc.rescheduleHearingDeadlines(p.billKey);
  });

  bus.subscribe('workflow:autostart', ['note.document_saved'], async (ev) => {
    const p = ev.payload as { noteRevisionId: string; actorId?: string; metadata?: boolean };
    if (p.metadata || !p.actorId) return;
    await svc.autoStart(p.noteRevisionId, p.actorId);
  });

  if (opts.workers) {
    let timer: NodeJS.Timeout | null = null;
    app.addHook('onReady', async () => {
      timer = setInterval(() => void svc.pollDeadlines().catch((err) => app.log.error({ err }, 'deadline poll failed')), app.config.DEADLINE_POLL_MS);
      timer.unref();
    });
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
    });
  }
  return svc;
}
