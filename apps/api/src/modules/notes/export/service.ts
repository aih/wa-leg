// Export service: renders a stored document version as HTML, PDF, DOCX or FNS XML, records the export,
// audits it, and emits `note.exported`.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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

  /** Render and store one export. Viewers get the approved version; participants default to the head. */
  async export(p: Principal, noteRevisionId: string, opts: { format: ExportFormat; version?: number; strict?: boolean }, requestId: string): Promise<ExportResult> {
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
    let body: Buffer;
    switch (opts.format) {
      case 'html':
        body = Buffer.from(docToHtmlDocument(doc, { title, mode: stored.mode, linkOrigin: this.app.config.WEB_ORIGIN, footer, katex: 'inline' }), 'utf8');
        break;
      case 'pdf': {
        if (!this.app.config.PDF_ENABLED) throw unavailable('pdf_disabled', 'PDF rendering is switched off (PDF_ENABLED=false)');
        const html = docToHtmlDocument(doc, { title, mode: stored.mode, linkOrigin: this.app.config.WEB_ORIGIN, footer, katex: 'file' });
        body = await htmlToPdf(html, { footerLeft: footer, workDir: join(this.app.config.EXPORT_DIR, 'tmp') });
        break;
      }
      case 'docx':
        body = await docToDocx(doc, { title, billNumber: summary.versionLabel });
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
      await writeAudit(tx, { actorId: p.userId, action: 'note.export', objectType: 'note_revision', objectId: noteRevisionId, after: { exportId, format: opts.format, version, bytes: body.length }, requestId });
      await emitEvent(tx, 'note.exported', { noteRevisionId, exportId, format: opts.format, version, actorId: p.userId });
    });
    this.app.bus.kick();
    return { exportId, format: opts.format, version, filename, contentType: CONTENT_TYPES[opts.format], body };
  }
}
