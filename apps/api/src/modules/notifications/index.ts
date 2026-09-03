import type { FastifyInstance } from 'fastify';
import { NotificationsService } from './service.js';
import { notificationsRoutes } from './routes.js';
import { MemoryMailer, NullMailer, SmtpMailer, type Mailer } from './mailer.js';

export { NotificationsService, notificationsRoutes, MemoryMailer, NullMailer, SmtpMailer };
export type { Mailer };

declare module 'fastify' {
  interface FastifyInstance {
    notificationsSvc: NotificationsService;
  }
}

/** Create the notifications service on the root instance and subscribe to the events it renders. */
export function createNotifications(app: FastifyInstance, mailer?: Mailer): NotificationsService {
  const cfg = app.config;
  const chosen = mailer ?? (cfg.NODE_ENV === 'test' ? new MemoryMailer() : cfg.NOTIFY_EMAIL ? new SmtpMailer(cfg.SMTP_URL, cfg.MAIL_FROM) : new NullMailer());
  const svc = new NotificationsService(app, app.db, chosen);
  app.decorate('notificationsSvc', svc);
  const bus = app.bus;
  bus.subscribe('notifications:transitions', ['note.transitioned'], (ev) => svc.onTransitioned(ev));
  bus.subscribe('notifications:assignments', ['note.assigned'], (ev) => svc.onAssigned(ev));
  bus.subscribe('notifications:deadlines', ['note.due_soon', 'note.overdue'], (ev) => svc.onDeadline(ev));
  bus.subscribe('notifications:bills', ['bill.version_added', 'bill.amendment_added', 'hearing.scheduled', 'hearing.rescheduled', 'hearing.cancelled'], (ev) => svc.onBillChanged(ev));
  return svc;
}
