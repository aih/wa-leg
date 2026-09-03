export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers = new Headers(opts.headers);
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers.set('content-type', 'application/json');
  const res = await fetch(url, {
    ...opts,
    headers,
    credentials: 'same-origin',
    body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const d = (data ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, d.code ?? 'error', d.message ?? res.statusText, data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function loginUrl(returnTo: string = window.location.pathname + window.location.search, loginHint?: string): string {
  return `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}${loginHint ? `&login_hint=${encodeURIComponent(loginHint)}` : ''}`;
}
