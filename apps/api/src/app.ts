import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { randomUUID } from 'node:crypto';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { createDb, type Db, type DbHandle } from './db/client.js';
import { HttpError } from './lib/errors.js';
import { OutboxRelay } from './lib/outbox.js';
import type { Logger } from 'pino';
import { principalPlugin, identityRoutes, createOidcClient, type OidcClient } from './modules/identity/index.js';
import { adminRoutes } from './modules/admin/index.js';
import { billsRoutes, BillsService } from './modules/bills/index.js';
import { createSearch, searchRoutes } from './modules/search/index.js';
import { TemplatesService, templatesRoutes } from './modules/templates/index.js';
import { ReferenceService, referenceRoutes } from './modules/reference/index.js';
import { createNotes, notesRoutes } from './modules/notes/index.js';
import { createWorkflow, workflowRoutes } from './modules/workflow/index.js';
import { createNotifications, notificationsRoutes, type Mailer } from './modules/notifications/index.js';

export type HealthProbe = () => Promise<{ ok: boolean; detail?: string }>;

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Db;
    dbHandle: DbHandle;
    bus: OutboxRelay;
    healthChecks: Record<string, HealthProbe>;
  }
}

export interface BuildOptions {
  config: Config;
  /** Reuse an existing pool (tests). */
  dbHandle?: DbHandle;
  oidc?: OidcClient;
  /** Start background workers (outbox relay, pollers) on ready. Default true. */
  workers?: boolean;
  /** Notification delivery adapter override (tests). */
  mailer?: Mailer;
}

export const API_PREFIX = '/api/v1';

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { config } = opts;
  const app = Fastify({
    logger:
      config.NODE_ENV === 'test'
        ? { level: process.env.LOG_LEVEL ?? 'warn' }
        : config.NODE_ENV === 'development'
          ? { level: config.LOG_LEVEL, transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
          : { level: config.LOG_LEVEL },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 20 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const dbHandle = opts.dbHandle ?? createDb(config.DATABASE_URL);
  app.decorate('config', config);
  app.decorate('db', dbHandle.db);
  app.decorate('dbHandle', dbHandle);
  app.decorate('bus', new OutboxRelay(dbHandle.db, app.log as unknown as Logger, config.OUTBOX_POLL_MS));
  app.decorate('healthChecks', {} as Record<string, HealthProbe>);
  app.decorate('oidc', opts.oidc ?? createOidcClient(config));

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) req.log.error({ err }, err.message);
      return reply.code(err.status).send({ code: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError || (err as { validation?: unknown }).validation) {
      return reply.code(400).send({ code: 'validation', message: err.message, details: (err as any).validation ?? (err as ZodError).issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({ code: (err as { code?: string }).code ?? 'internal', message: status >= 500 && config.NODE_ENV === 'production' ? 'Internal error' : err.message });
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(cors, { origin: [config.WEB_ORIGIN], credentials: true });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Fiscal Note Workbench API',
        version: '1.0.0',
        description: 'REST API for the DOR fiscal note proof of concept. All paths are served under /api/v1.',
      },
      servers: [{ url: API_PREFIX }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'session' },
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ session: [] }, { bearer: [] }],
      tags: ['identity', 'bills', 'search', 'notes', 'templates', 'workflow', 'notifications', 'reference', 'admin'].map((name) => ({ name })),
    },
    transform: jsonSchemaTransform,
    stripBasePath: true,
  });

  await app.register(principalPlugin);

  // Module services live on the root instance; routes register under the API prefix.
  app.decorate('bills', new BillsService(dbHandle.db));
  app.decorate('templates', new TemplatesService(dbHandle.db));
  app.decorate('reference', new ReferenceService(dbHandle.db, config.CURRENT_BIENNIUM));
  const search = createSearch(app);
  const notes = createNotes(app);
  const workflow = createWorkflow(app, { workers: opts.workers ?? true });
  createNotifications(app, opts.mailer);

  await app.register(
    async (api) => {
      api.get('/openapi.json', { schema: { hide: true } }, async () => {
        const doc = app.swagger() as { paths: Record<string, unknown> };
        // Routes are registered under the prefix; the served document keeps server-relative paths.
        const paths: Record<string, unknown> = {};
        for (const [p, v] of Object.entries(doc.paths ?? {})) {
          paths[p.startsWith(API_PREFIX) ? p.slice(API_PREFIX.length) || '/' : p] = v;
        }
        return { ...doc, paths };
      });
      await api.register(identityRoutes);
      await api.register(adminRoutes);
      await api.register(billsRoutes);
      await api.register(searchRoutes(search));
      await api.register(templatesRoutes);
      await api.register(referenceRoutes);
      await api.register(notesRoutes(notes));
      await api.register(workflowRoutes(workflow));
      await api.register(notificationsRoutes(app.notificationsSvc));
      for (const mod of moduleRegistrars) await api.register(mod);
    },
    { prefix: API_PREFIX },
  );

  app.addHook('onReady', async () => {
    if (opts.workers ?? true) app.bus.start();
  });
  app.addHook('onClose', async () => {
    app.bus.stop();
    if (!opts.dbHandle) await dbHandle.close();
  });

  return app;
}

/** Module route registrars added by later milestones. Each registers under /api/v1. */
export const moduleRegistrars: Array<(app: FastifyInstance) => Promise<void>> = [];
