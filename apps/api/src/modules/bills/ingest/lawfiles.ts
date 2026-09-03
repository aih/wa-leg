// Fetches lawfilesext documents with an on-disk cache keyed by URL and ETag (conditional GET).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FetchedDocument {
  url: string;
  status: number;
  body: string | null;
  etag?: string;
  lastModified?: string;
  sha256?: string;
  fromCache: boolean;
  fetchedAt: string;
}

export interface DocumentFetcher {
  fetch(url: string, opts?: { force?: boolean }): Promise<FetchedDocument>;
}

interface CacheMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  sha256?: string;
  status: number;
  file?: string;
  fetchedAt: string;
}

export function xmlUrlFromPdf(pdfUrl: string): string {
  return pdfUrl.replace('/Pdf/', '/Xml/').replace(/\.pdf$/i, '.xml');
}

export function htmUrlFromPdf(pdfUrl: string): string {
  return pdfUrl.replace('/Pdf/', '/Htm/').replace(/\.pdf$/i, '.htm');
}

export function fileNameOf(url: string): string {
  return decodeURIComponent(url.split('/').pop() ?? '');
}

export function sha256Hex(data: string | Buffer): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

/** HTTP fetcher with conditional requests and a disk cache. Missing documents (404) are cached too. */
export class CachingFetcher implements DocumentFetcher {
  private inflight = new Map<string, Promise<FetchedDocument>>();

  constructor(
    private readonly cacheDir: string,
    private readonly opts: { userAgent?: string; timeoutMs?: number; concurrency?: number; negativeTtlMs?: number } = {},
  ) {
    mkdirSync(cacheDir, { recursive: true });
  }

  private keyOf(url: string): string {
    return createHash('sha1').update(url).digest('hex');
  }

  private metaPath(url: string): string {
    return join(this.cacheDir, `${this.keyOf(url)}.meta.json`);
  }

  private readMeta(url: string): CacheMeta | null {
    const p = this.metaPath(url);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as CacheMeta;
    } catch {
      return null;
    }
  }

  private cachedBody(meta: CacheMeta): string | null {
    if (!meta.file) return null;
    const p = join(this.cacheDir, meta.file);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  async fetch(url: string, opts: { force?: boolean } = {}): Promise<FetchedDocument> {
    const existing = this.inflight.get(url);
    if (existing) return existing;
    const p = this.doFetch(url, opts).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async doFetch(url: string, opts: { force?: boolean }): Promise<FetchedDocument> {
    const meta = this.readMeta(url);
    const now = new Date().toISOString();
    if (meta && !opts.force) {
      if (meta.status === 404) {
        const age = Date.now() - new Date(meta.fetchedAt).getTime();
        if (age < (this.opts.negativeTtlMs ?? 24 * 3600_000)) return { url, status: 404, body: null, fromCache: true, fetchedAt: meta.fetchedAt };
      } else if (meta.status === 200 && !meta.etag && !meta.lastModified) {
        const body = this.cachedBody(meta);
        if (body !== null) return { url, status: 200, body, sha256: meta.sha256, fromCache: true, fetchedAt: meta.fetchedAt };
      }
    }
    const headers: Record<string, string> = { 'user-agent': this.opts.userAgent ?? 'wa-leg-fiscal-note-workbench/0.1 (+dev)' };
    if (meta?.etag && !opts.force) headers['if-none-match'] = meta.etag;
    if (meta?.lastModified && !opts.force) headers['if-modified-since'] = meta.lastModified;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await globalThis.fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timer);
      // Network failure: serve the cache when there is one.
      if (meta && meta.status === 200) {
        const body = this.cachedBody(meta);
        if (body !== null) return { url, status: 200, body, etag: meta.etag, lastModified: meta.lastModified, sha256: meta.sha256, fromCache: true, fetchedAt: meta.fetchedAt };
      }
      throw err;
    }
    clearTimeout(timer);
    if (res.status === 304 && meta) {
      const body = this.cachedBody(meta);
      if (body !== null) {
        this.writeMeta(url, { ...meta, fetchedAt: now });
        return { url, status: 200, body, etag: meta.etag, lastModified: meta.lastModified, sha256: meta.sha256, fromCache: true, fetchedAt: meta.fetchedAt };
      }
      // Cache file lost: refetch unconditionally.
      return this.doFetch(url, { force: true });
    }
    if (res.status === 404) {
      this.writeMeta(url, { url, status: 404, fetchedAt: now });
      return { url, status: 404, body: null, fromCache: false, fetchedAt: now };
    }
    if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    const sha = sha256Hex(buf);
    const ext = url.toLowerCase().endsWith('.htm') ? 'htm' : url.toLowerCase().endsWith('.pdf') ? 'pdf' : 'xml';
    const file = `${this.keyOf(url)}.${etag ? etag.replace(/[^a-zA-Z0-9]/g, '') : sha.slice(7, 19)}.${ext}`;
    writeFileSync(join(this.cacheDir, file), buf);
    this.writeMeta(url, { url, etag, lastModified, sha256: sha, status: 200, file, fetchedAt: now });
    return { url, status: 200, body: text, etag, lastModified, sha256: sha, fromCache: false, fetchedAt: now };
  }

  private writeMeta(url: string, meta: CacheMeta): void {
    writeFileSync(this.metaPath(url), JSON.stringify(meta));
  }
}

/** Serves documents from a directory by file name; for tests and offline runs. */
export class DirectoryFetcher implements DocumentFetcher {
  constructor(private readonly dir: string) {}
  async fetch(url: string): Promise<FetchedDocument> {
    const name = fileNameOf(url);
    const p = join(this.dir, name);
    const now = new Date().toISOString();
    if (!existsSync(p)) return { url, status: 404, body: null, fromCache: true, fetchedAt: now };
    const buf = readFileSync(p);
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { url, status: 200, body: text, sha256: sha256Hex(buf), fromCache: true, fetchedAt: now };
  }
}

/** Run async work over items with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
