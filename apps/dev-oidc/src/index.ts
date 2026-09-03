// Development OpenID Connect issuer. Serves a fixed set of test users (users.json) and signs
// tokens with a key pair generated at startup. Not for production.
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, jwtVerify } from 'jose';

interface DevUser {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  divisions: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const users: DevUser[] = JSON.parse(readFileSync(join(here, '..', 'users.json'), 'utf8'));

const ISSUER = process.env.ISSUER ?? 'http://localhost:4801';
const PORT = Number(process.env.PORT ?? 4801);
const CLIENT_ID = process.env.CLIENT_ID ?? 'wa-leg-web';
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? 'dev-client-secret';
const REDIRECT_URIS = (process.env.REDIRECT_URIS ?? 'http://localhost:4800/api/v1/auth/callback').split(',');

interface PendingCode {
  user: DevUser;
  nonce?: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

const codes = new Map<string, PendingCode>();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export async function buildIssuer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const kid = 'dev-' + randomBytes(4).toString('hex');
  const jwk = { ...(await exportJWK(publicKey)), kid, use: 'sig', alg: 'RS256' };

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(formbody);

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
    jwks_uri: `${ISSUER}/jwks`,
    end_session_endpoint: `${ISSUER}/logout`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'roles'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    claims_supported: ['sub', 'email', 'name', 'roles', 'divisions'],
    code_challenge_methods_supported: ['S256', 'plain'],
    grant_types_supported: ['authorization_code'],
  }));

  app.get('/jwks', async () => ({ keys: [jwk] }));

  app.get('/users', async () => users.map(({ sub, email, name, roles, divisions }) => ({ sub, email, name, roles, divisions })));

  app.get<{ Querystring: Record<string, string> }>('/authorize', async (req, reply) => {
    const q = req.query;
    if (q.client_id !== CLIENT_ID) return reply.code(400).send({ error: 'invalid_client' });
    if (!q.redirect_uri || !REDIRECT_URIS.includes(q.redirect_uri)) return reply.code(400).send({ error: 'invalid_redirect_uri' });
    if (q.response_type !== 'code') return reply.code(400).send({ error: 'unsupported_response_type' });

    const hint = q.login_hint;
    const user = hint ? users.find((u) => u.sub === hint || u.email === hint) : undefined;
    if (!user) {
      const params = new URLSearchParams(q);
      const rows = users
        .map((u) => {
          params.set('login_hint', u.sub);
          return `<li><a class="user" href="/authorize?${escapeHtml(params.toString())}" data-user="${escapeHtml(u.sub)}">
            <strong>${escapeHtml(u.name)}</strong> <span>${escapeHtml(u.roles.join(', '))}</span></a></li>`;
        })
        .join('\n');
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dev sign-in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
ul{list-style:none;padding:0}li{margin:.5rem 0}a.user{display:flex;justify-content:space-between;gap:1rem;padding:.75rem 1rem;border:1px solid #bbb;border-radius:6px;background:#fff;color:inherit;text-decoration:none}
a.user:focus,a.user:hover{outline:3px solid #2a6fdb;outline-offset:2px}span{color:#555}</style></head>
<body><h1>Development sign-in</h1><p>Choose a test user. Roles are shown beside each name.</p><ul>${rows}</ul></body></html>`;
      return reply.type('text/html').send(html);
    }

    const code = randomBytes(24).toString('base64url');
    codes.set(code, {
      user,
      nonce: q.nonce,
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method,
      expiresAt: Date.now() + 5 * 60_000,
    });
    const url = new URL(q.redirect_uri);
    url.searchParams.set('code', code);
    if (q.state) url.searchParams.set('state', q.state);
    return reply.redirect(url.toString(), 302);
  });

  async function signToken(user: DevUser, extra: Record<string, unknown>, aud: string, ttlSeconds: number) {
    return new SignJWT({ email: user.email, name: user.name, roles: user.roles, divisions: user.divisions, ...extra })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setSubject(user.sub)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(privateKey);
  }

  app.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
    const b = req.body ?? {};
    let clientId = b.client_id;
    let clientSecret = b.client_secret;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      clientId = decodeURIComponent(id ?? '');
      clientSecret = decodeURIComponent(secret ?? '');
    }
    if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
      return reply.code(401).send({ error: 'invalid_client' });
    }
    if (b.grant_type !== 'authorization_code') return reply.code(400).send({ error: 'unsupported_grant_type' });
    const pending = b.code ? codes.get(b.code) : undefined;
    if (!pending || pending.expiresAt < Date.now()) return reply.code(400).send({ error: 'invalid_grant' });
    codes.delete(b.code as string);
    if (b.redirect_uri && b.redirect_uri !== pending.redirectUri) return reply.code(400).send({ error: 'invalid_grant' });
    if (pending.codeChallenge) {
      const verifier = b.code_verifier ?? '';
      const expected =
        pending.codeChallengeMethod === 'S256' ? createHash('sha256').update(verifier).digest('base64url') : verifier;
      if (expected !== pending.codeChallenge) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE' });
    }
    const idToken = await signToken(pending.user, pending.nonce ? { nonce: pending.nonce } : {}, CLIENT_ID, 3600);
    const accessToken = await signToken(pending.user, { scope: 'openid profile email roles' }, CLIENT_ID, 3600);
    return {
      token_type: 'Bearer',
      id_token: idToken,
      access_token: accessToken,
      expires_in: 3600,
      scope: 'openid profile email roles',
    };
  });

  app.get('/userinfo', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'invalid_token' });
    try {
      const { payload } = await jwtVerify(auth.slice(7), publicKey, { issuer: ISSUER });
      const user = users.find((u) => u.sub === payload.sub);
      if (!user) return reply.code(401).send({ error: 'invalid_token' });
      return { sub: user.sub, email: user.email, name: user.name, roles: user.roles, divisions: user.divisions };
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/logout', async (req, reply) => {
    const to = req.query.post_logout_redirect_uri;
    if (to) return reply.redirect(to, 302);
    return reply.type('text/html').send('<!doctype html><p>Signed out.</p>');
  });

  app.get('/health', async () => ({ ok: true, issuer: ISSUER }));

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const app = await buildIssuer();
  await app.listen({ port: PORT, host: '0.0.0.0' });
}
