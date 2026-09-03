// Published feed: every published note revision, newest first, with the four export URLs.
import { sql } from 'drizzle-orm';
import { label as shortLabel, type BillType } from '@wa-leg/billref';
import type { Db } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';

export const EXPORT_FORMATS = ['pdf', 'docx', 'html', 'xml'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface PublishedItem {
  revisionId: string;
  bill: { biennium: string; billId: string; number: string; title: string };
  versionCode: string;
  versionLabel: string;
  title: string;
  publishedAt: string;
  publishedBy: { userId: string; displayName: string };
  publishedVersion: number;
  exports: Record<ExportFormat, string>;
}

export interface PublishedPage {
  items: PublishedItem[];
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Absolute export URLs for a note revision: `{origin}/api/v1/notes/{revisionId}/export?format={pdf|docx|html|xml}`. */
export function exportUrls(origin: string, revisionId: string): Record<ExportFormat, string> {
  const base = `${origin.replace(/\/$/, '')}/api/v1/notes/${revisionId}/export?format=`;
  return { pdf: `${base}pdf`, docx: `${base}docx`, html: `${base}html`, xml: `${base}xml` };
}

function encodeCursor(publishedAt: string, revisionId: string): string {
  return Buffer.from(`${publishedAt}|${revisionId}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { publishedAt: string; revisionId: string } {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = text.indexOf('|');
  const publishedAt = sep > 0 ? text.slice(0, sep) : '';
  const revisionId = sep > 0 ? text.slice(sep + 1) : '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(publishedAt) || !/^[0-9a-f-]{36}$/.test(revisionId)) throw badRequest('bad_cursor', 'cursor is not from this feed');
  return { publishedAt, revisionId };
}

interface Row {
  note_revision_id: string;
  version_code: string;
  published_at: Date | string;
  published_by: string;
  published_version: number;
  bill_key: string;
  bill_title: string | null;
  short_label: string | null;
  display_name: string | null;
}

export class PublishedService {
  constructor(
    private readonly db: Db,
    private readonly origin: string,
  ) {}

  async list(query: { limit?: number; cursor?: string } = {}): Promise<PublishedPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const where = after
      ? sql`WHERE r.published_at IS NOT NULL AND (r.published_at, r.note_revision_id::text) < (${after.publishedAt}::timestamptz, ${after.revisionId})`
      : sql`WHERE r.published_at IS NOT NULL`;
    const rows = (
      await this.db.execute(sql`SELECT r.note_revision_id, r.version_code, r.published_at, r.published_by, r.published_version,
          n.bill_key, b.title AS bill_title, v.short_label, u.display_name
        FROM note_revisions r
        JOIN notes n ON n.note_id = r.note_id
        LEFT JOIN bills b ON b.bill_key = n.bill_key
        LEFT JOIN bill_versions v ON v.bill_key = n.bill_key AND v.version_code = r.version_code
        LEFT JOIN users u ON u.user_id = r.published_by
        ${where}
        ORDER BY r.published_at DESC, r.note_revision_id DESC
        LIMIT ${limit + 1}`)
    ).rows as unknown as Row[];
    const page = rows.slice(0, limit);
    const items = page.map((r) => this.item(r));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor(last.publishedAt, last.revisionId) : null };
  }

  private item(r: Row): PublishedItem {
    const [, biennium = '', billId = ''] = r.bill_key.split(':');
    const type = billId.replace(/\d+$/, '') as BillType;
    const number = billId.replace(/^[A-Z]+/, '');
    const versionLabel = r.short_label ?? shortLabel({ type, number: Number(number), versionCode: r.version_code });
    const publishedAt = r.published_at instanceof Date ? r.published_at.toISOString() : new Date(r.published_at).toISOString();
    return {
      revisionId: r.note_revision_id,
      bill: { biennium, billId, number, title: r.bill_title ?? '' },
      versionCode: r.version_code,
      versionLabel,
      title: `${versionLabel} Fiscal Note`,
      publishedAt,
      publishedBy: { userId: r.published_by, displayName: r.display_name ?? r.published_by },
      publishedVersion: Number(r.published_version),
      exports: exportUrls(this.origin, r.note_revision_id),
    };
  }
}
