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

/** `HB2402-S-fiscal-note.pdf`; an introduced version (`I`) has no version suffix: `HB1004-fiscal-note.pdf`. */
export function exportFilename(billId: string, versionCode: string, format: ExportFormat): string {
  const stem = versionCode && versionCode !== 'I' ? `${billId}-${versionCode}` : billId;
  return `${stem}-fiscal-note.${format}`;
}

/** `September 3, 2026` in Olympia's time zone. */
export function publishedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'long', day: 'numeric' });
}

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

  /**
   * Render and store one export. Drafters and reviewers get the head version, the approved version of an
   * approved note, or the published version of a published note. Viewers and anonymous callers get the
   * published version of a published note and 404 otherwise.
   */
  async export(p: Principal | null, noteRevisionId: string, opts: { format: ExportFormat; version?: number; strict?: boolean }, requestId: string): Promise<ExportResult> {
    const participant = !!p && (p.roles.includes('admin') || p.roles.includes('reviewer') || p.roles.includes('drafter'));
    const ctx = participant ? await this.notes.assertCan(p!, 'note.export', noteRevisionId, requestId) : await this.notes.resource(noteRevisionId);
    if (!participant && ctx.state.state !== 'published') throw notFound('Published note');
    const summary = await this.notes.summary(noteRevisionId, ctx);
    const frozen = summary.state === 'published' ? summary.publishedVersion : summary.state === 'approved' ? summary.approvedVersion : null;
    let version = opts.version;
    if (version === undefined) version = participant ? (frozen ?? summary.headVersion) : (summary.publishedVersion ?? undefined);
    if (version === undefined) throw notFound('Published version');
    if (!participant && version !== summary.publishedVersion) throw forbidden('Only the published version is available');
    const actorId = p?.userId ?? 'anonymous';
    const stored = await this.notes.getDocument(noteRevisionId, version);
    const doc = recompute(stored.doc as PMNode).doc;
    const missing = unfilledSlots(doc);
    if (opts.strict && missing.length) throw unprocessable('unfilled_slots', `${missing.length} required slot(s) are empty`, { unfilledSlots: missing });
    const facts = await this.notes.billFacts(summary.billKey, p ?? undefined);
    const title = `${summary.versionLabel} Fiscal Note`;
    const published = summary.state === 'published' && summary.publishedAt ? `Published ${publishedDate(summary.publishedAt)}` : null;
    const footer = ['Form FN (Rev 1/00)', `Bill # ${summary.versionLabel}`, 'FNS062 Department of Revenue Fiscal Note', published].filter(Boolean).join('   ');
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
        body = await docToDocx(doc, { title, billNumber: summary.versionLabel, identifier: published });
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
    const filename = exportFilename(summary.billId, summary.versionCode, opts.format);
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO note_exports (id, note_revision_id, format, document_version, status, path, content_type, size_bytes, created_by)
        VALUES (${exportId}, ${noteRevisionId}, ${opts.format}, ${version}, 'done', ${path}, ${CONTENT_TYPES[opts.format]}, ${body.length}, ${actorId})`);
      await writeAudit(tx, { actorId, action: 'note.export', objectType: 'note_revision', objectId: noteRevisionId, after: { exportId, format: opts.format, version, bytes: body.length }, requestId });
      await emitEvent(tx, 'note.exported', { noteRevisionId, exportId, format: opts.format, version, actorId });
    });
    this.app.bus.kick();
    return { exportId, format: opts.format, version, filename, contentType: CONTENT_TYPES[opts.format], body };
  }
}
