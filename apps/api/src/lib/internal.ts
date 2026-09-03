// Module-to-module calls go through the HTTP API (ARCHITECTURE.md "Contracts between modules").
// `internalCall` injects a request with a short-lived system bearer token.
import type { FastifyInstance } from 'fastify';
import { signSession, SYSTEM_PRINCIPAL, type Principal } from '../modules/identity/index.js';
import { HttpError } from './errors.js';

export interface InternalOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  as?: Principal;
  headers?: Record<string, string>;
}

const tokenCache = new WeakMap<FastifyInstance, Map<string, { token: string; exp: number }>>();

export async function internalToken(app: FastifyInstance, principal: Principal = SYSTEM_PRINCIPAL): Promise<string> {
  let cache = tokenCache.get(app);
  if (!cache) {
    cache = new Map();
    tokenCache.set(app, cache);
  }
  const hit = cache.get(principal.userId);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const token = await signSession(principal, app.config.SESSION_SECRET, 3600);
  cache.set(principal.userId, { token, exp: Date.now() + 3600_000 });
  return token;
}

/** Call another module's route in-process. Throws HttpError on non-2xx. */
export async function internalCall<T = unknown>(app: FastifyInstance, url: string, opts: InternalOptions = {}): Promise<T> {
  const token = await internalToken(app, opts.as);
  const res = await app.inject({
    method: opts.method ?? 'GET',
    url: url.startsWith('/api/') ? url : `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
    payload: opts.body === undefined ? undefined : (opts.body as Record<string, unknown>),
  });
  if (res.statusCode === 204) return undefined as T;
  if (res.statusCode >= 400) {
    let body: any = null;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    throw new HttpError(res.statusCode, body?.code ?? 'internal_call_failed', `${opts.method ?? 'GET'} ${url} → ${res.statusCode}: ${body?.message ?? res.body}`, body);
  }
  return res.json() as T;
}
