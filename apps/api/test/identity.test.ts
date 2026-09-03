import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, truncate, users, type TestContext } from './helpers.js';
import { emitEvent } from '../src/lib/outbox.js';

let t: TestContext;

beforeAll(async () => {
  t = await createTestApp();
  await truncate(t.handle, ['audit_log', 'outbox']);
});
afterAll(async () => {
  await t.close();
});

describe('identity and foundation routes', () => {
  it('GET /api/v1/me returns 401 without a session', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /api/v1/me returns the principal for a bearer session token', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: 'dev-drafter', roles: ['drafter'], divisions: ['RFA'] });
  });

  it('GET /api/v1/me accepts the session cookie', async () => {
    const { authorization } = await t.as(users.reviewer);
    const token = authorization.replace('Bearer ', '');
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me', cookies: { session: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe('dev-reviewer');
  });

  it('login redirects to the identity provider and sets the login cookie', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/login?returnTo=/inbox' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('issuer.test/authorize');
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('callback exchanges the code, sets the session, records an audit row and redirects to returnTo', async () => {
    const login = await t.app.inject({ method: 'GET', url: '/api/v1/auth/login?returnTo=/inbox' });
    const cookie = (login.headers['set-cookie'] as string[] | string) ?? '';
    const loginCookie = (Array.isArray(cookie) ? cookie : [cookie]).find((c) => c.startsWith('oidc_login='))!;
    const value = decodeURIComponent(loginCookie.split(';')[0]!.slice('oidc_login='.length));
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/callback?code=abc&state=' + JSON.parse(value).state,
      cookies: { oidc_login: value },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/inbox');
    const setCookie = res.headers['set-cookie'] as string[];
    expect(setCookie.some((c) => c.startsWith('session='))).toBe(true);
    const audit = await t.app.inject({ method: 'GET', url: '/api/v1/admin/audit?action=auth.login', headers: await t.as(users.admin) });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()[0]).toMatchObject({ actorId: 'dev-drafter', action: 'auth.login', objectType: 'user' });
  });

  it('logout clears the cookie', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toContain('session=;');
  });

  it('serves the OpenAPI document with server-relative paths', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0].url).toBe('/api/v1');
    expect(doc.paths['/me'].get.tags).toEqual(['identity']);
    expect(doc.paths['/health']).toBeTruthy();
    expect(doc.components.securitySchemes.session.in).toBe('cookie');
  });

  it('health reports postgres', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.postgres.ok).toBe(true);
  });

  it('audit query is refused for drafters and the denial is itself audited', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers: await t.as(users.drafter) });
    expect(res.statusCode).toBe(403);
    const audit = await t.app.inject({ method: 'GET', url: '/api/v1/admin/audit?action=permission.denied', headers: await t.as(users.reviewer) });
    expect(audit.json()[0]).toMatchObject({ actorId: 'dev-drafter', action: 'permission.denied' });
  });

  it('outbox relay delivers each event once per consumer', async () => {
    const seen: string[] = [];
    t.app.bus.subscribe('test-consumer', 'test.event', async (ev) => {
      seen.push(ev.payload.n);
    });
    t.app.bus.subscribe('test-consumer-2', ['test.event'], async (ev) => {
      seen.push('b' + ev.payload.n);
    });
    await t.app.db.transaction(async (tx) => {
      await emitEvent(tx, 'test.event', { n: '1' });
      await emitEvent(tx, 'test.other', { n: 'x' });
    });
    await t.app.bus.drain();
    await t.app.bus.drain();
    expect(seen.sort()).toEqual(['1', 'b1']);
  });
});
