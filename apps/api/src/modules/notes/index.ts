import type { FastifyInstance } from 'fastify';
import { NotesService } from './service.js';
import { notesRoutes } from './routes.js';
import { ExportService } from './export/service.js';
import { closePdfRenderer } from './export/pdf.js';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../../lib/audit.js';

export { NotesService, notesRoutes, ExportService };
export type { ExportFormat } from './export/service.js';
export { buildTemplateContext, fnsBillNumber } from './context.js';
export { readNoteState } from './state.js';

declare module 'fastify' {
  interface FastifyInstance {
    notesModule: NotesService;
  }
}

/** Create the notes service on the root instance and subscribe to bill events. */
export function createNotes(app: FastifyInstance): NotesService {
  const svc = new NotesService(app, app.db);
  svc.exports = new ExportService(app, app.db, svc);
  app.decorate('notesModule', svc);
  app.addHook('onClose', async () => {
    await closePdfRenderer();
  });
  // Approval freezes the head as the published version.
  app.bus.subscribe('notes:approved', ['note.approved'], async (ev) => {
    const { noteRevisionId, approvedBy } = ev.payload as { noteRevisionId: string; approvedBy?: string };
    await app.db.transaction(async (tx) => {
      const row = (await tx.execute(sql`SELECT head_version FROM note_revisions WHERE note_revision_id = ${noteRevisionId}`)).rows[0] as { head_version: number } | undefined;
      if (!row) return;
      await tx.execute(sql`UPDATE note_revisions SET approved_document_version = ${row.head_version}, updated_at = now() WHERE note_revision_id = ${noteRevisionId}`);
      await tx.execute(sql`UPDATE note_documents SET label = COALESCE(label, 'Approved') WHERE note_revision_id = ${noteRevisionId} AND version = ${row.head_version}`);
      await writeAudit(tx, { actorId: approvedBy ?? 'system', action: 'note.publish', objectType: 'note_revision', objectId: noteRevisionId, after: { approvedVersion: row.head_version }, requestId: `event:${ev.eventId}` });
    });
  });
  // A new bill version: offer a new revision to the drafter (automatic creation is configurable).
  app.bus.subscribe('notes:bill-versions', ['bill.version_added'], async (ev) => {
    const { billKey, versionCode } = ev.payload as { billKey: string; versionCode: string };
    if (!app.config.AUTO_REVISION_ON_NEW_VERSION) return;
    const { sql } = await import('drizzle-orm');
    const open = (await app.db.execute(sql`SELECT r.note_revision_id, r.created_by FROM note_revisions r JOIN notes n ON n.note_id = r.note_id
        WHERE n.bill_key = ${billKey} AND r.version_code <> ${versionCode}
        AND NOT EXISTS (SELECT 1 FROM note_revisions r2 WHERE r2.note_id = n.note_id AND r2.version_code = ${versionCode})`)).rows as { note_revision_id: string; created_by: string }[];
    const { SYSTEM_PRINCIPAL } = await import('../identity/index.js');
    for (const o of open) {
      try {
        await svc.createRevision(SYSTEM_PRINCIPAL, o.note_revision_id, { versionCode }, `event:${ev.eventId}`);
      } catch (err) {
        app.log.warn({ err, billKey, versionCode }, 'automatic revision failed');
      }
    }
  });
  return svc;
}
