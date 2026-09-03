import type { FastifyInstance } from 'fastify';
import { NotesService } from './service.js';
import { notesRoutes } from './routes.js';
import { ExportService } from './export/service.js';
import { closePdfRenderer } from './export/pdf.js';

export { NotesService, notesRoutes, ExportService };
export type { ExportFormat } from './export/service.js';
export type { NoteRevisionSummary, CreateNoteInput } from './service.js';
export { buildTemplateContext, fnsBillNumber } from './context.js';
import { invalidateBillFacts } from './context.js';
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
  app.bus.subscribe('notes:bill-facts', ['bill.created', 'bill.version_added', 'bill.amendment_added', 'bill.status_changed', 'hearing.scheduled', 'hearing.rescheduled', 'hearing.cancelled'], async (ev) => {
    invalidateBillFacts(app, (ev.payload as { billKey?: string }).billKey);
  });
  return svc;
}
