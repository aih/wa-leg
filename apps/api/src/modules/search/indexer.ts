// Keeps the search indices in step with the bills module through the event bus and the REST API.
import type { FastifyInstance } from 'fastify';
import type { AmendmentDocument, BillDocument } from '@wa-leg/bill-document';
import type { SearchBackend, SearchDoc } from './backend.js';
import { buildAmendmentDoc, buildBillDoc, buildOfmNoteDocs, buildRcwDocs, buildSectionDocs, type BillSummaryLike } from './docs.js';
import { internalCall } from '../../lib/internal.js';
import { sectionText } from '@wa-leg/bill-document';

export class SearchIndexer {
  constructor(
    private readonly app: FastifyInstance,
    private readonly backend: SearchBackend,
  ) {}

  /** Rebuild every document for one bill from the bills API. */
  async indexBill(billKey: string): Promise<number> {
    const [, biennium, id] = billKey.split(':');
    const bill = await internalCall<BillSummaryLike>(this.app, `/bills/${biennium}/${id}`);
    const docs: SearchDoc[] = [buildBillDoc(bill)];
    const latest = bill.versions[bill.versions.length - 1]?.code;
    for (const v of bill.versions) {
      if (v.status !== 'parsed') continue;
      try {
        const doc = await internalCall<BillDocument>(this.app, `/bills/${biennium}/${id}/versions/${encodeURIComponent(v.code)}`);
        docs.push(...buildSectionDocs(bill, doc, v.shortLabel, v.code === latest));
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
    // Write the new documents first, then drop the stale ones, so a concurrent search never sees the bill missing.
    await this.backend.index(docs);
    await this.backend.removeWhere({ bill_key: billKey, exceptIds: docs.map((d) => d.id) });
    return docs.length;
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
    const reindexBill = async (ev: { payload: { billKey?: string } }) => {
      if (ev.payload.billKey) await this.indexBill(ev.payload.billKey);
    };
    this.app.bus.subscribe('search:bills', ['bill.created', 'bill.version_added', 'bill.amendment_added', 'bill.status_changed', 'hearing.scheduled', 'hearing.rescheduled', 'hearing.cancelled'], reindexBill);
  }
}

export { sectionText };
