import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { SESSION_COOKIE, verifySession } from './session.js';
import type { Principal } from './principal.js';
import { unauthorized } from '../../lib/errors.js';
import type { OidcClient } from './oidc.js';
import { pgTextArray } from '../../lib/sql.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    oidc: OidcClient;
  }
}

/** Resolves the principal for every request from the session cookie or a bearer token. */
export const principalPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (req) => {
    const cfg = app.config;
    let principal: Principal | null = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      principal = (await verifySession(token, cfg.SESSION_SECRET)) ?? (await app.oidc.verifyBearer(token));
    }
    if (!principal) {
      const cookie = req.cookies[SESSION_COOKIE];
      if (cookie) principal = await verifySession(cookie, cfg.SESSION_SECRET);
    }
    req.principal = principal;
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.principal) throw unauthorized();
  });
});

/** Upsert the user row on login so other modules can resolve display names. */
export async function rememberUser(app: FastifyInstance, p: Principal): Promise<void> {
  await app.db.execute(sql`INSERT INTO users (user_id, subject, display_name, email, roles, divisions, last_seen_at)
    VALUES (${p.userId}, ${p.userId}, ${p.displayName}, ${p.email ?? null}, ${pgTextArray(p.roles)}::text[], ${pgTextArray(p.divisions)}::text[], now())
    ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email,
      roles = EXCLUDED.roles, divisions = EXCLUDED.divisions, last_seen_at = now()`);
}
