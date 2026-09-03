// Query pipeline (search.md section 4): parse the query, resolve a bare reference to a direct hit, run the text path.
import { parse as parseRef, label as shortLabelOf, type BillRef, type Ref } from '@wa-leg/billref';
import type { FastifyInstance } from 'fastify';
import type { Principal } from '../identity/index.js';
import type { SearchBackend, SearchDoc, SearchFilters, SearchRequest, SearchResult, Suggestion } from './backend.js';
import { internalCall } from '../../lib/internal.js';

export interface DirectHit {
  kind: string;
  bill_key?: string;
  display?: string;
  title?: string;
  resolved_version_code?: string;
  resolved_version_label?: string;
  url?: string | null;
  external_url?: string;
  amendment_id?: string;
  ambiguous: boolean;
  candidates: { bill_key: string; display: string; title?: string; biennium: string; url: string }[];
  warnings: string[];
  related?: {
    amendments: { amendment_id: string; disposition?: string | null; disposition_date?: string | null; sponsor?: string | null; url?: string | null }[];
    companion: { bill_key: string; display: string; title?: string; url: string } | null;
    fiscal_notes: { note_id: string; source: string; title?: string | null; status?: string | null; url?: string | null }[];
    rcw: { cite: string; action: string }[];
  };
}

export interface SearchResponse {
  query: string;
  parsed: (Ref & { remainder?: string }) | null;
  direct: DirectHit | null;
  hits: SearchResult['hits'];
  facets: SearchResult['facets'];
  page: number;
  size: number;
  total: number;
  took_ms: number;
  backend: string;
}

interface ResolveResult {
  parsed: Ref;
  remainder: string;
  resolved: { bill_key: string; id: string; title?: string; version_code: string; version_label?: string; url: string; amendmentId?: string } | null;
  ambiguous?: boolean;
  candidates?: { bill_key: string; id?: string; title?: string; url: string }[];
  external?: string | null;
  notFound?: boolean;
}

export class SearchPipeline {
  constructor(
    private readonly app: FastifyInstance,
    private readonly backend: SearchBackend,
  ) {}

  private async resolve(q: string, biennium: string, principal: Principal): Promise<ResolveResult | null> {
    try {
      return await internalCall<ResolveResult>(this.app, `/bills/resolve?ref=${encodeURIComponent(q)}&biennium=${encodeURIComponent(biennium)}`, { as: principal });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 400) return null;
      if (status === 404) return (err as { details?: ResolveResult }).details ?? null;
      throw err;
    }
  }

  private async related(billKey: string, principal: Principal): Promise<NonNullable<DirectHit['related']>> {
    const docs = await this.backend.listByBill(billKey, ['amendment', 'fiscal_note'], principal, 60);
    const amendments = docs
      .filter((d) => d.doc_type === 'amendment')
      .sort((a, b) => (b.disposition_date ?? '').localeCompare(a.disposition_date ?? ''))
      .slice(0, 20)
      .map((d) => ({ amendment_id: d.amendment_id ?? d.id, disposition: d.disposition ?? null, disposition_date: d.disposition_date ?? null, sponsor: d.sponsor ?? null, url: d.url ?? null }));
    const fiscal_notes = docs
      .filter((d) => d.doc_type === 'fiscal_note')
      .slice(0, 10)
      .map((d) => ({ note_id: d.note_id ?? d.id, source: d.source ?? '', title: d.title ?? null, status: d.status ?? null, url: d.url ?? null }));
    const bill = (await this.backend.get([billKey], principal))[0];
    let companion: NonNullable<DirectHit['related']>['companion'] = null;
    if (bill?.companion_bill_key) {
      const c = (await this.backend.get([bill.companion_bill_key], principal))[0];
      if (c) companion = { bill_key: c.bill_key!, display: c.display ?? c.bill_key!, title: c.title ?? undefined, url: c.url ?? `/bills/${c.biennium}/${c.bill_number}` };
    }
    const cites = bill?.rcw_cites ?? [];
    const chapters = (bill?.rcw_chapters ?? []).filter((c) => !cites.some((x) => x.startsWith(c + '.')));
    const titles = (bill?.rcw_titles ?? []).filter((t) => !cites.some((x) => x.startsWith(t + '.')) && !(bill?.rcw_chapters ?? []).some((x) => x.startsWith(t + '.')));
    const rcw = [...cites.map((c) => ({ cite: c, action: 'amend' })), ...chapters.map((c) => ({ cite: c, action: 'new_section' })), ...titles.map((c) => ({ cite: c, action: 'new_chapter' }))];
    return { amendments, companion, fiscal_notes, rcw };
  }

  async search(params: { q?: string; biennium?: string; page?: number; size?: number; sort?: SearchRequest['sort'] } & SearchFilters, principal: Principal, currentBiennium: string): Promise<SearchResponse> {
    const started = Date.now();
    const q = (params.q ?? '').trim();
    const biennium = params.biennium ?? currentBiennium;
    const filters: SearchFilters = { ...params, biennium };
    delete (filters as any).q;
    delete (filters as any).page;
    delete (filters as any).size;
    delete (filters as any).sort;
    let parsed: SearchResponse['parsed'] = null;
    let direct: DirectHit | null = null;
    let textQuery = q;

    if (q) {
      const p = parseRef(q, { currentBiennium: biennium === 'all' ? currentBiennium : biennium });
      if (p.ref) {
        parsed = { ...p.ref, remainder: p.remainder };
        textQuery = p.remainder;
        const ref = p.ref;
        if (ref.kind === 'bill' || (ref.kind === 'amendment' && ref.drafterNumber)) {
          const r = await this.resolve(q.slice(0, q.length - p.remainder.length).trim() || q, biennium === 'all' ? currentBiennium : biennium, principal);
          direct = toDirect(ref, r);
          if (direct?.bill_key) {
            direct.related = await this.related(direct.bill_key, principal);
            if (textQuery) filters.bill_key = direct.bill_key;
          }
        } else if (ref.kind === 'rcw') {
          direct = { kind: 'rcw', ambiguous: false, candidates: [], warnings: [], external_url: `https://app.leg.wa.gov/RCW/default.aspx?cite=${ref.cite}`, display: `RCW ${ref.cite}` };
          if (ref.section) filters.rcw_cites = [ref.section];
          else if (ref.chapter) filters.rcw_chapters = [ref.chapter];
          else filters.rcw_titles = [ref.title];
          if (!textQuery) params.sort = params.sort ?? 'date';
        } else if (ref.kind === 'fiscal_note_package') {
          const docs = await this.backend.get([`fn:ofm:${ref.packageId}`], principal);
          const d = docs[0];
          direct = { kind: 'fiscal_note_package', ambiguous: false, candidates: [], warnings: d ? [] : ['package not indexed'], url: d?.url ?? null, external_url: `https://fnspublic.ofm.wa.gov/FNSPublicSearch/GetPDF?packageID=${ref.packageId}`, display: d?.display ?? `Package ${ref.packageId}`, title: d?.title ?? undefined, bill_key: d?.bill_key ?? undefined };
          if (d?.bill_key && !textQuery) filters.bill_key = d.bill_key;
        } else if (ref.kind === 'session_law') {
          direct = { kind: 'session_law', ambiguous: false, candidates: [], warnings: [], external_url: `https://app.leg.wa.gov/billsummary?Chapter=${ref.chapter}&Year=${ref.year}`, display: `Chapter ${ref.chapter}, Laws of ${ref.year}` };
          textQuery = `Chapter ${ref.chapter}, ${ref.year} Laws`;
        } else if (ref.kind === 'initiative') {
          direct = { kind: 'initiative', ambiguous: false, candidates: [], warnings: [], external_url: `https://app.leg.wa.gov/billsummary?BillNumber=${ref.number}&Year=${currentBiennium.slice(0, 4)}&Initiative=true`, display: `Initiative ${ref.number}` };
        }
      }
    }

    const req: SearchRequest = { q: textQuery, filters, page: Math.max(1, params.page ?? 1), size: Math.min(100, Math.max(1, params.size ?? 20)), sort: params.sort ?? 'relevance' };
    const hasFilter = Object.entries(filters).some(([k, v]) => k !== 'biennium' && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));
    const runText = !!textQuery || hasFilter || !direct;
    const result = runText ? await this.backend.search(req, principal) : { hits: [], facets: {}, total: 0, took_ms: 0 };
    return { query: q, parsed, direct, hits: result.hits, facets: result.facets, page: req.page, size: req.size, total: result.total, took_ms: Date.now() - started, backend: this.backend.name };
  }

  async suggest(q: string, biennium: string, principal: Principal, size: number): Promise<{ query: string; reference: Ref | null; suggestions: Suggestion[]; took_ms: number }> {
    const started = Date.now();
    const p = parseRef(q, { currentBiennium: biennium });
    const suggestions: Suggestion[] = [];
    if (p.ref?.kind === 'bill' && !p.remainder) {
      const r = await this.resolve(q, biennium, principal);
      if (r?.resolved) suggestions.push({ kind: 'bill', bill_key: r.resolved.bill_key, display: r.resolved.id.replace(/^([A-Z]+)(\d+)$/, '$1 $2'), label: r.resolved.version_label, title: r.resolved.title, url: r.resolved.url });
      for (const c of r?.candidates ?? []) suggestions.push({ kind: 'bill', bill_key: c.bill_key, display: c.id ?? c.bill_key, title: c.title, url: c.url });
    }
    const more = await this.backend.suggest(q, biennium, principal, size);
    const seen = new Set(suggestions.map((s) => s.bill_key ?? s.note_id));
    for (const s of more) {
      const k = s.bill_key ?? s.note_id;
      if (k && seen.has(k)) continue;
      seen.add(k);
      suggestions.push(s);
      if (suggestions.length >= size) break;
    }
    return { query: q, reference: p.ref, suggestions, took_ms: Date.now() - started };
  }
}

function toDirect(ref: Ref, r: ResolveResult | null): DirectHit | null {
  if (!r) return null;
  const warnings = ref.kind === 'bill' ? [...ref.warnings] : [];
  if (r.resolved) {
    const res = r.resolved;
    if (ref.kind === 'bill' && ref.versionExplicit && ref.versionCode !== res.version_code) warnings.push(`version ${ref.versionCode} not found; showing ${res.version_code}`);
    const out: DirectHit = {
      kind: ref.kind,
      bill_key: res.bill_key,
      display: res.id.replace(/^([A-Z]+)(\d+)$/, '$1 $2'),
      title: res.title,
      resolved_version_code: res.version_code,
      resolved_version_label: res.version_label ?? (ref.kind === 'bill' ? shortLabelOf(ref as BillRef) : undefined),
      url: res.url,
      ambiguous: false,
      candidates: [],
      warnings,
    };
    if (res.amendmentId) out.amendment_id = res.amendmentId;
    return out;
  }
  return {
    kind: ref.kind,
    ambiguous: !!r.ambiguous,
    candidates: (r.candidates ?? []).map((c) => ({ bill_key: c.bill_key, display: (c.id ?? c.bill_key.split(':').pop() ?? '').replace(/^([A-Z]+)(\d+)$/, '$1 $2'), title: c.title, biennium: c.bill_key.split(':')[1] ?? '', url: c.url })),
    warnings: [...warnings, 'not found'],
    url: null,
  };
}

export type { SearchDoc };
