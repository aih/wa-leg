// Typed client for the Fiscal Note Workbench API. `schema.d.ts` is generated from the OpenAPI document by
// `pnpm --filter @wa-leg/api-client generate`; regenerate it whenever a route or schema changes.
import createOpenApiClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema.js';

export type { paths, components, operations } from './schema.js';

export interface WaLegClientOptions extends ClientOptions {
  /** Bearer token; the browser app relies on the session cookie instead. */
  token?: string;
}

/** Create a client. `baseUrl` defaults to `/api/v1` relative to the page, which suits the web app and the Vite proxy. */
export function createClient(opts: WaLegClientOptions = {}) {
  const { token, ...rest } = opts;
  const headers = new Headers(rest.headers as HeadersInit | undefined);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return createOpenApiClient<paths>({ baseUrl: '/api/v1', credentials: 'same-origin', ...rest, headers });
}

export type WaLegClient = ReturnType<typeof createClient>;
