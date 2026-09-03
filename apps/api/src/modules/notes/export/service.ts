// Export service: renders a stored document version as HTML, PDF, DOCX or FNS XML, records the export,
// audits it, and emits `note.exported`.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { extractEstimateData, recompute, unfilledSlots, type PMNode } from '@wa-leg/note-schema';
import type { Db } from '../../../db/client.js';
import { writeAudit } from '../../../lib/audit.js';
import { emitEvent } from '../../../lib/outbox.js';
import { forbidden, notFound, unavailable, unprocessable } from '../../../lib/errors.js';
import type { Principal } from '../../identity/index.js';
import type { NotesService } from '../service.js';
import { docToDocx } from './docx.js';
import { docToHtmlDocument } from './html.js';
import { htmlToPdf } from './pdf.js';
import { PlaceholderFnsXmlMapper, type FnsXmlMapper } from './fns-xml.js';

export type ExportFormat = 'html' | 'pdf' | 'docx' | 'xml';

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xml: 'application/xml; charset=utf-8',
};

export interface ExportResult {
  exportId: string;
  format: ExportFormat;
  version: number;
  filename: string;
  contentType: string;
  body: Buffer;
}

export class ExportService {
  readonly fns: FnsXmlMapper = new PlaceholderFnsXmlMapper();

  constructor(
    private readonly app: FastifyInstance,
    private readonly db: Db,
    private readonly notes: NotesService,
  ) {}

  /** Render and store one export. Viewers get the approved snapshot; editors default to the head. */
  async export(p: Principal, noteRevisionId: string, opts: { format: ExportFormat; version?: number; comments?: boolean; strict?: boolean }, requestId: string): Promise<ExportResult> {
    const ctx = await this.notes.assertCan(p, 'note.export', noteRevisionId, requestId);
    const summary = await this.notes.summary(noteRevisionId, ctx);
    const participant = p.roles.includes('admin') || p.roles.includes('reviewer') || summary.drafter?.userId === p.userId;
    let version = opts.version;
    if (version === undefined) version = participant ? summary.headVersion : (summary.approvedVersion ?? undefined);
    if (version === undefined) throw notFound('Approved version');
    if (!participant && summary.approvedVersion !== null && version !== summary.approvedVersion) throw forbidden('Only the approved version is available');
    const stored = await this.notes.getDocument(noteRevisionId, version);
    const doc = recompute(stored.doc as PMNode).doc;
    const missing = unfilledSlots(doc);
    if ((opts.strict || opts.format === 'xml') && missing.length) throw unprocessable('unfilled_slots', `${missing.length} required slot(s) are empty`, { unfilledSlots: missing });
    const facts = await this.notes.billFacts(summary.billKey, p);
    const title = `${summary.versionLabel} Fiscal Note`;
    const footer = ['Form FN (Rev 1/00)', `Bill # ${summary.versionLabel}`, 'FNS062 Department of Revenue Fiscal Note'].join('   ');
    const comments = opts.comments ? await this.commentMap(noteRevisionId) : undefined;
    let body: Buffer;
    switch (opts.format) {
      case 'html':
        body = Buffer.from(docToHtmlDocument(doc, { title, mode: stored.mode, comments, linkOrigin: this.app.config.WEB_ORIGIN, footer, katex: 'inline' }), 'utf8');
        break;
      case 'pdf': {
        if (!this.app.config.PDF_ENABLED) throw unavailable('pdf_disabled', 'PDF rendering is switched off (PDF_ENABLED=false)');
        const html = docToHtmlDocument(doc, { title, mode: stored.mode, comments, linkOrigin: this.app.config.WEB_ORIGIN, footer, katex: 'file' });
        body = await htmlToPdf(html, { footerLeft: footer, workDir: join(this.app.config.EXPORT_DIR, 'tmp') });
        break;
      }
      case 'docx':
        body = await docToDocx(doc, { title, billNumber: summary.versionLabel, comments });
        break;
      case 'xml': {
        const estimate = extractEstimateData(doc);
        body = Buffer.from(
          this.fns.render({
            header: { billNumber: summary.versionLabel, billTitle: facts?.title ?? summary.billTitle ?? '', agencyCode: '140', agencyName: 'Department of Revenue', versionLabel: summary.versionLabel, preparedBy: { name: summary.drafter?.displayName ?? '', date: stored.updatedAt.slice(0, 10) } },
            doc,
            estimate,
            mode: stored.mode,
          }),
          'utf8',
        );
        break;
      }
    }
    const exportId = randomUUID();
    const dir = join(this.app.config.EXPORT_DIR, noteRevisionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${exportId}.${opts.format}`);
    writeFileSync(path, body);
    const filename = `${summary.versionLabel.replace(/\s+/g, '_')}_fiscal_note_v${version}.${opts.format}`;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO note_exports (id, note_revision_id, format, document_version, status, path, content_type, size_bytes, created_by)
        VALUES (${exportId}, ${noteRevisionId}, ${opts.format}, ${version}, 'done', ${path}, ${CONTENT_TYPES[opts.format]}, ${body.length}, ${p.userId})`);
      await writeAudit(tx, { actorId: p.userId, action: 'note.export', objectType: 'note_revision', objectId: noteRevisionId, after: { exportId, format: opts.format, version, comments: !!opts.comments, bytes: body.length }, requestId });
      await emitEvent(tx, 'note.exported', { noteRevisionId, exportId, format: opts.format, version, actorId: p.userId });
    });
    this.app.bus.kick();
    return { exportId, format: opts.format, version, filename, contentType: CONTENT_TYPES[opts.format], body };
  }

  /** A stored export, re-served with the same permission check as a fresh export. */
  async stored(p: Principal, noteRevisionId: string, exportId: string, requestId: string): Promise<ExportResult> {
    await this.notes.assertCan(p, 'note.export', noteRevisionId, requestId);
    const row = (await this.db.execute(sql`SELECT * FROM note_exports WHERE id = ${exportId} AND note_revision_id = ${noteRevisionId}`)).rows[0] as any;
    if (!row) throw notFound('Export');
    const summary = await this.notes.summary(noteRevisionId);
    if (summary.approvedVersion !== null && row.document_version !== summary.approvedVersion && !(p.roles.some((r) => ['reviewer', 'admin'].includes(r)) || summary.drafter?.userId === p.userId)) throw forbidden('Only the approved version is available');
    const body = readFileSync(row.path);
    return { exportId, format: row.format, version: row.document_version, filename: `${summary.versionLabel.replace(/\s+/g, '_')}_fiscal_note_v${row.document_version}.${row.format}`, contentType: row.content_type, body };
  }

  async job(p: Principal, exportId: string): Promise<{ status: string; url: string | null; format: string; version: number; noteRevisionId: string }> {
    const row = (await this.db.execute(sql`SELECT * FROM note_exports WHERE id = ${exportId}`)).rows[0] as any;
    if (!row) throw notFound('Export job');
    await this.notes.assertCan(p, 'note.export', row.note_revision_id);
    return { status: row.status, url: `/api/v1/notes/${row.note_revision_id}/exports/${exportId}`, format: row.format, version: row.document_version, noteRevisionId: row.note_revision_id };
  }

  async list(p: Principal, noteRevisionId: string, requestId: string) {
    await this.notes.assertCan(p, 'note.export', noteRevisionId, requestId);
    const rows = (await this.db.execute(sql`SELECT e.*, u.display_name FROM note_exports e LEFT JOIN users u ON u.user_id = e.created_by WHERE note_revision_id = ${noteRevisionId} ORDER BY created_at DESC LIMIT 100`)).rows as any[];
    return rows.map((r) => ({ exportId: r.id, format: r.format, version: r.document_version, status: r.status, sizeBytes: r.size_bytes, createdBy: r.created_by, createdByName: r.display_name ?? null, createdAt: new Date(r.created_at).toISOString(), url: `/api/v1/notes/${noteRevisionId}/exports/${r.id}` }));
  }

  private async commentMap(noteRevisionId: string): Promise<Map<string, { author: string; body: string; date: Date }>> {
    const threads = await this.notes.listComments(noteRevisionId);
    const map = new Map<string, { author: string; body: string; date: Date }>();
    for (const t of threads) {
      const first = t.messages[0];
      map.set(t.id, { author: first?.authorName ?? t.createdBy, body: t.messages.map((m) => `${m.authorName}: ${m.body}`).join('\n'), date: new Date(t.createdAt) });
    }
    return map;
  }
}
