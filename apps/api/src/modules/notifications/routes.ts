import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { NotificationsService } from './service.js';

const NotificationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  payload: z.looseObject({}),
  link: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  emailedAt: z.string().nullable(),
});

export function notificationsRoutes(svc: NotificationsService) {
  return async function routes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/notifications',
      { schema: { tags: ['notifications'], summary: 'Inbox (unread first)', querystring: z.object({ unread: z.union([z.boolean(), z.string()]).optional(), limit: z.coerce.number().int().optional() }), response: { 200: z.array(NotificationSchema) } }, preHandler: app.requireAuth },
      async (req) => svc.list(req.principal!, { unread: req.query.unread === true || req.query.unread === 'true', limit: req.query.limit }),
    );

    r.get(
      '/notifications/unread-count',
      { schema: { tags: ['notifications'], summary: 'Unread count for the nav badge', response: { 200: z.object({ unread: z.number() }) } }, preHandler: app.requireAuth },
      async (req) => ({ unread: await svc.unreadCount(req.principal!) }),
    );

    r.post(
      '/notifications/read-all',
      { schema: { tags: ['notifications'], summary: 'Mark every notification read', response: { 200: z.object({ marked: z.number() }) } }, preHandler: app.requireAuth },
      async (req) => ({ marked: await svc.markRead(req.principal!, 'all') }),
    );

    r.post(
      '/notifications/:id/read',
      { schema: { tags: ['notifications'], summary: 'Mark read', params: z.object({ id: z.string() }), response: { 204: z.null() } }, preHandler: app.requireAuth },
      async (req, reply) => {
        await svc.markRead(req.principal!, req.params.id);
        return reply.code(204).send(null);
      },
    );
  };
}
