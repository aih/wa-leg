// Keeps the search indices in step with the bills and notes modules through the event bus and the REST API.
import type { FastifyInstance } from 'fastify';
import type { AmendmentDocument, BillDocument } from '@wa-leg/bill-document';
import type { SearchBackend, SearchDoc } from './backend.js';
import { buildAmendmentDoc, buildBillDoc, buildInternalNoteDoc, buildOfmNoteDocs, buildRcwDocs, buildSectionDocs, type BillSummaryLike, type InternalNoteLike } from './docs.js';
import { internalCall } from '../../lib/internal.js';
import { sectionText } from '@wa-leg/bill-document';

export class SearchIndexer {
  constructor(
    private readonly app: FastifyInstance,
    private readonly backend: SearchBackend,
  ) {}

  /** Rebuild every document for one bill from the bills API. */
  async indexBill(billKey: string, opts: { notes?: InternalNoteLike[] } = {}): Promise<number> {
    const [, biennium, id] = billKey.split(':');
    const bill = await internalCall<BillSummaryLike>(this.app, `/bills/${biennium}/${id}`);
    const notes = opts.notes ?? (await this.notesFor(billKey));
    const docs: SearchDoc[] = [buildBillDoc(bill, notes.map((n) => ({ status: n.state, assigneeIds: [n.drafter?.userId, n.reviewer?.userId].filter((x): x is string => !!x) })))];
    const noteStatus = docs[0]!.fiscal_note_status ?? null;
    const latest = bill.versions[bill.versions.length - 1]?.code;
    for (const v of bill.versions) {
      if (v.status !== 'parsed') continue;
      try {
        const doc = await internalCall<BillDocument>(this.app, `/bills/${biennium}/${id}/versions/${encodeURIComponent(v.code)}`);
        docs.push(...buildSectionDocs(bill, doc, v.shortLabel, v.code === latest, noteStatus));
      } catch (err) {
        this.app.log.warn({ err, billKey, code: v.code }, 'version not indexed');
      }
    }
    try {
      const amendments = await internalCall<Parameters<typeof buildAmendmentDoc>[1][]>(this.app, `/bills/${biennium}/${id}/amendments`);
      for (const a of amendments) {
        let doc: AmendmentDocument | null = null;
        if (a.status === 'parsed') {
          try {
            doc = await internalCall<AmendmentDocument>(this.app, `/bills/${biennium}/${id}/amendments/${encodeURIComponent(a.amendmentId)}`);
          } catch {
            doc = null;
          }
        }
        docs.push(buildAmendmentDoc(bill, a, doc));
      }
    } catch (err) {
      this.app.log.warn({ err, billKey }, 'amendments not indexed');
    }
    docs.push(...buildOfmNoteDocs(bill));
    docs.push(...buildRcwDocs(bill));
    for (const n of notes) docs.push(buildInternalNoteDoc(n, { biennium: bill.biennium, id: bill.id, type: bill.type, number: bill.number, chamber: bill.chamber, title: bill.title }));
    // Write the new documents first, then drop the stale ones, so a concurrent search never sees the bill missing.
    await this.backend.index(docs);
    await this.backend.removeWhere({ bill_key: billKey, exceptIds: docs.map((d) => d.id) });
    return docs.length;
  }

  private async notesFor(billKey: string): Promise<InternalNoteLike[]> {
    if (!this.app.hasDecorator('notesModule')) return [];
    try {
      const [, biennium, id] = billKey.split(':');
      const rows = await internalCall<InternalNoteLike[]>(this.app, `/bills/${biennium}/${id}/notes`);
      return rows;
    } catch {
      return [];
    }
  }

  /** Reindex one internal note revision from the notes API. */
  async indexNote(noteRevisionId: string): Promise<void> {
    if (!this.app.hasDecorator('notesModule')) return;
    let n: InternalNoteLike & { document?: unknown };
    try {
      n = await internalCall<InternalNoteLike>(this.app, `/notes/${noteRevisionId}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        await this.backend.remove([`fn:int:${noteRevisionId}`]);
        return;
      }
      throw err;
    }
    let bodyText = '';
    try {
      const doc = await internalCall<{ doc: unknown }>(this.app, `/notes/${noteRevisionId}/document`);
      bodyText = plainTextOfProseMirror(doc.doc);
    } catch {
      bodyText = '';
    }
    const [, biennium, id] = n.billKey.split(':');
    let bill: { biennium: string; id: string; type: string; number: number; chamber: string; title: string } | null = null;
    try {
      bill = await internalCall<BillSummaryLike>(this.app, `/bills/${biennium}/${id}`);
    } catch {
      bill = null;
    }
    await this.backend.index([buildInternalNoteDoc({ ...n, bodyText }, bill)]);
    // The bill document carries note status and assignees; refresh it too.
    try {
      await this.indexBill(n.billKey);
    } catch (err) {
      this.app.log.warn({ err, billKey: n.billKey }, 'bill not reindexed after note change');
    }
  }

  async indexTemplate(t: { id: string; name: string; kind: string; description?: string; html: string; version: number; tags?: string[] }): Promise<void> {
    await this.backend.index([
      {
        id: `tpl:${t.id}:${t.version}`,
        doc_type: 'template',
        template_id: t.id,
        name: t.name,
        title: t.name,
        kind: t.kind,
        description: t.description ?? null,
        body: `${t.description ?? ''}\n${t.html.replace(/<[^>]+>/g, ' ')}`.replace(/\s+/g, ' ').trim(),
        heading: (t.tags ?? []).join(' '),
        url: `/admin/templates#${t.id}`,
        visibility: 'restricted',
        allowed_roles: ['drafter', 'reviewer', 'approver', 'manager', 'template_editor', 'admin'],
        allowed_user_ids: [],
        updated_at: new Date().toISOString(),
        source_hash: null,
      },
    ]);
  }

  /** Full load: every bill in the biennium through the bills API. */
  async loadAll(opts: { biennium: string; limit?: number; onProgress?: (m: string) => void }): Promise<{ bills: number; docs: number; errors: string[] }> {
    let page = 1;
    let bills = 0;
    let docs = 0;
    const errors: string[] = [];
    for (;;) {
      const rows = await internalCall<{ billKey: string }[]>(this.app, `/bills?biennium=${opts.biennium}&page=${page}&size=200`);
      if (!rows.length) break;
      for (const r of rows) {
        if (opts.limit && bills >= opts.limit) return { bills, docs, errors };
        try {
          docs += await this.indexBill(r.billKey);
          bills += 1;
          if (bills % 50 === 0) opts.onProgress?.(`${bills} bills, ${docs} documents`);
        } catch (err) {
          errors.push(`${r.billKey}: ${(err as Error).message}`);
        }
      }
      page += 1;
    }
    await this.backend.refresh();
    return { bills, docs, errors };
  }

  subscribe(): void {
    const bus = this.app.bus;
    const reindexBill = async (ev: { payload: { billKey?: string } }) => {
      if (ev.payload.billKey) await this.indexBill(ev.payload.billKey);
    };
    bus.subscribe('search:bills', ['bill.created', 'bill.version_added', 'bill.amendment_added', 'bill.status_changed', 'hearing.scheduled', 'hearing.rescheduled', 'hearing.cancelled'], reindexBill);
    bus.subscribe('search:notes', ['note.created', 'note.revision_created', 'note.document_saved', 'note.transitioned', 'note.approved', 'note.superseded'], async (ev) => {
      const id = ev.payload.noteRevisionId as string | undefined;
      if (id) await this.indexNote(id);
    });
  }
}

/** Plain text of a ProseMirror JSON document (text nodes joined with spaces). */
export function plainTextOfProseMirror(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.text === 'string') out.push(n.text);
    if (n.attrs && typeof n.attrs.latex === 'string') out.push(n.attrs.latex);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    if (n.type && /paragraph|heading|tableCell|listItem/.test(n.type)) out.push('\n');
  };
  walk(doc);
  return out.join(' ').replace(/[ \t]+/g, ' ').trim();
}

export { sectionText };
