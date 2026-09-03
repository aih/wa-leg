import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrincipalSchema } from './principal.js';
import { SESSION_COOKIE, signSession } from './session.js';
import { rememberUser } from './plugin.js';
import { badRequest } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

const LOGIN_COOKIE = 'oidc_login';

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const cfg = app.config;

  r.get(
    '/me',
    {
      schema: {
        tags: ['identity'],
        summary: 'Current principal',
        response: { 200: PrincipalSchema, 401: z.object({ code: z.string(), message: z.string() }) },
      },
      preHandler: app.requireAuth,
    },
    async (req) => req.principal!,
  );

  r.get(
    '/auth/login',
    {
      schema: {
        tags: ['identity'],
        summary: 'Start OIDC login (redirect)',
        querystring: z.object({ returnTo: z.string().optional(), login_hint: z.string().optional() }),
        security: [],
      },
    },
    async (req, reply) => {
      const state = randomBytes(16).toString('base64url');
      const nonce = randomBytes(16).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      const returnTo = safeReturnTo(req.query.returnTo);
      const url = await app.oidc.authorizationUrl(state, nonce, codeVerifier, req.query.login_hint);
      reply.setCookie(LOGIN_COOKIE, JSON.stringify({ state, nonce, codeVerifier, returnTo }), {
        path: '/api/v1/auth',
        httpOnly: true,
        sameSite: 'lax',
        secure: cfg.SESSION_COOKIE_SECURE,
        maxAge: 600,
      });
      return reply.redirect(url.toString(), 302);
    },
  );

  r.get(
    '/auth/callback',
    { schema: { tags: ['identity'], summary: 'OIDC callback', security: [] } },
    async (req, reply) => {
      const raw = req.cookies[LOGIN_COOKIE];
      if (!raw) throw badRequest('login_state_missing', 'Login state cookie missing; start login again');
      const { state, nonce, codeVerifier, returnTo } = JSON.parse(raw) as {
        state: string;
        nonce: string;
        codeVerifier: string;
        returnTo: string;
      };
      const current = new URL(req.raw.url ?? '/', cfg.PUBLIC_API_ORIGIN);
      // The redirect URI registered with the IdP must match exactly.
      const registered = new URL(cfg.OIDC_REDIRECT_URI);
      current.protocol = registered.protocol;
      current.host = registered.host;
      current.pathname = registered.pathname;
      const principal = await app.oidc.exchange(current, state, nonce, codeVerifier);
      await rememberUser(app, principal);
      const token = await signSession(principal, cfg.SESSION_SECRET, cfg.SESSION_TTL_SECONDS);
      reply.clearCookie(LOGIN_COOKIE, { path: '/api/v1/auth' });
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: cfg.SESSION_COOKIE_SECURE,
        maxAge: cfg.SESSION_TTL_SECONDS,
      });
      await writeAudit(app.db, {
        actorId: principal.userId,
        action: 'auth.login',
        objectType: 'user',
        objectId: principal.userId,
        after: { roles: principal.roles },
        requestId: req.id,
      });
      return reply.redirect(new URL(returnTo, cfg.WEB_ORIGIN).toString(), 302);
    },
  );

  r.post(
    '/auth/logout',
    { schema: { tags: ['identity'], summary: 'End session', response: { 204: z.null() } } },
    async (req, reply) => {
      if (req.principal) {
        await writeAudit(app.db, {
          actorId: req.principal.userId,
          action: 'auth.logout',
          objectType: 'user',
          objectId: req.principal.userId,
          requestId: req.id,
        });
      }
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(204).send(null);
    },
  );

  r.get(
    '/auth/logout',
    { schema: { tags: ['identity'], summary: 'End session and redirect to the app', security: [] } },
    async (_req, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      const end = await app.oidc.endSessionUrl();
      return reply.redirect(end ? end.toString() : cfg.WEB_ORIGIN, 302);
    },
  );
}

function safeReturnTo(v: string | undefined): string {
  if (!v || !v.startsWith('/') || v.startsWith('//')) return '/';
  return v;
}
