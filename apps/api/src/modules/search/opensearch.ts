// OpenSearch implementation of SearchBackend (search.md sections 3 and 4).
import { Client } from '@opensearch-project/opensearch';
import type { Principal } from '../identity/index.js';
import type { DocType, Facet, SearchBackend, SearchDoc, SearchHit, SearchRequest, SearchResult, Suggestion } from './backend.js';
import { SYNONYMS } from './synonyms.js';

export const INDEX_VERSION = 'v1';
export const INDICES: DocType[] = ['bill', 'section', 'amendment', 'fiscal_note', 'rcw_section', 'template'];
const INDEX_NAME: Record<DocType, string> = { bill: 'bills', section: 'bill_sections', amendment: 'amendments', fiscal_note: 'fiscal_notes', rcw_section: 'rcw_sections', template: 'templates' };

const analysis = {
  char_filter: { ampersand: { type: 'mapping', mappings: ['& => and'] } },
  filter: {
    legal_synonyms: { type: 'synonym_graph', expand: true, lenient: true, synonyms: SYNONYMS },
    legal_stem: { type: 'kstem' },
    possessive: { type: 'stemmer', language: 'possessive_english' },
    title_shingles: { type: 'shingle', min_shingle_size: 2, max_shingle_size: 3, output_unigrams: false },
  },
  analyzer: {
    legal_text: { type: 'custom', char_filter: ['ampersand'], tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'possessive', 'legal_stem'] },
    legal_text_search: { type: 'custom', char_filter: ['ampersand'], tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'possessive', 'legal_synonyms', 'legal_stem'] },
    title_shingle: { type: 'custom', char_filter: ['ampersand'], tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'title_shingles'] },
    billnum: { type: 'custom', tokenizer: 'keyword', filter: ['uppercase'] },
  },
  normalizer: { upper: { type: 'custom', filter: ['uppercase', 'trim'] } },
};

const kw = { type: 'keyword' };
const text = { type: 'text', analyzer: 'legal_text', search_analyzer: 'legal_text_search' };
const common = {
  doc_type: kw,
  bill_key: kw,
  biennium: kw,
  chamber: kw,
  type: kw,
  bill_number: { type: 'keyword', normalizer: 'upper' },
  display: kw,
  title: { ...text, fields: { shingles: { type: 'text', analyzer: 'title_shingle' }, sayt: { type: 'search_as_you_type', max_shingle_size: 3 }, keyword: { type: 'keyword', ignore_above: 512 } } },
  status: kw,
  committee: { properties: { id: kw, name: kw, chamber: kw } },
  has_fiscal_note: { type: 'boolean' },
  fiscal_note_status: kw,
  assigned_user_ids: kw,
  rcw_cites: kw,
  rcw_chapters: kw,
  rcw_titles: kw,
  version_code: kw,
  version_label: kw,
  last_action_date: { type: 'date' },
  url: { type: 'keyword', index: false },
  visibility: kw,
  allowed_roles: kw,
  allowed_user_ids: kw,
  updated_at: { type: 'date' },
  source_hash: kw,
  body: text,
  heading: { ...text, fields: { keyword: { type: 'keyword', ignore_above: 512 } } },
  description: text,
};

export const MAPPINGS: Record<DocType, Record<string, unknown>> = {
  bill: {
    ...common,
    number: { type: 'integer' },
    bill_number_forms: { type: 'keyword', normalizer: 'upper' },
    status_code: { type: 'integer' },
    sponsors: { type: 'object', properties: { people_id: kw, name: { type: 'text', analyzer: 'legal_text', fields: { keyword: kw } }, last_name: kw, party: kw, district: kw, primary: { type: 'boolean' } } },
    sponsor_names: { type: 'text', analyzer: 'legal_text' },
    companion_bill_key: kw,
    version_codes: kw,
    latest_version_code: kw,
    fiscal_note_count: { type: 'integer' },
    fiscal_note_package_ids: kw,
    history_text: { type: 'text', analyzer: 'legal_text' },
    last_action: { type: 'text', analyzer: 'legal_text', fields: { keyword: { type: 'keyword', ignore_above: 512 } } },
    next_hearing_date: { type: 'date' },
    hearing_count: { type: 'integer' },
    suggest: { type: 'completion', analyzer: 'simple', preserve_separators: false, contexts: [{ name: 'biennium', type: 'category' }] },
  },
  section: {
    ...common,
    is_latest_version: { type: 'boolean' },
    section_id: kw,
    section_no: kw,
    ordinal: { type: 'integer' },
    action: kw,
    rcw_cite: kw,
    rcw_chapter: kw,
    rcw_title: kw,
    text: { ...text, term_vector: 'with_positions_offsets' },
    added_text: text,
    struck_text: text,
  },
  amendment: {
    ...common,
    amendment_id: kw,
    target_version_code: kw,
    amending_chamber: kw,
    kind: kw,
    sponsor: kw,
    drafter_number: kw,
    amd_number: { type: 'integer' },
    disposition: kw,
    disposition_date: { type: 'date' },
    text: text,
  },
  fiscal_note: {
    ...common,
    note_id: kw,
    source: kw,
    package_id: kw,
    ofm_kind: kw,
    note_version: { type: 'integer' },
    author_id: kw,
    reviewer_ids: kw,
  },
  rcw_section: {
    ...common,
    cite: kw,
    rcw_cite: kw,
    rcw_chapter: kw,
    rcw_title: kw,
    caption: text,
    affected_by: { type: 'object', enabled: false },
    affected_by_bill_keys: kw,
  },
  template: {
    ...common,
    template_id: kw,
    name: text,
    kind: kw,
  },
};

const HIGHLIGHT_FIELDS = { title: { number_of_fragments: 0 }, heading: { number_of_fragments: 0 }, text: { fragment_size: 180, number_of_fragments: 2 }, body: { fragment_size: 180, number_of_fragments: 2 }, description: { fragment_size: 180, number_of_fragments: 1 } };

function permissionClause(p: Principal) {
  return { bool: { should: [{ term: { visibility: 'public' } }, { terms: { allowed_roles: p.roles } }, { term: { allowed_user_ids: p.userId } }], minimum_should_match: 1 } };
}

export class OpenSearchBackend implements SearchBackend {
  readonly name = 'opensearch' as const;
  readonly client: Client;
  constructor(
    url: string,
    private readonly prefix = 'waleg_',
  ) {
    this.client = new Client({ node: url, requestTimeout: 30_000 });
  }

  alias(t: DocType): string {
    return `${this.prefix}${INDEX_NAME[t]}`;
  }
  physical(t: DocType): string {
    return `${this.alias(t)}_${INDEX_VERSION}`;
  }
  get all(): string {
    return `${this.prefix}search_all`;
  }

  async init(): Promise<void> {
    for (const t of INDICES) {
      const name = this.physical(t);
      const exists = await this.client.indices.exists({ index: name });
      if (!exists.body) {
        await this.client.indices.create({
          index: name,
          body: { settings: { index: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '1s' }, analysis }, mappings: { dynamic: 'false', properties: MAPPINGS[t] } } as any,
        });
      }
      await this.client.indices.updateAliases({ body: { actions: [{ add: { index: name, alias: this.alias(t) } }, { add: { index: name, alias: this.all } }] } });
    }
  }

  private indexFor(doc: SearchDoc): string {
    return this.alias(doc.doc_type);
  }

  async index(docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const body: unknown[] = [];
    for (const d of docs) {
      const { id, ...rest } = d;
      const src: Record<string, unknown> = { ...rest };
      if (d.doc_type === 'bill' && d.suggest) src.suggest = { input: d.suggest.input, weight: d.suggest.weight ?? 10, contexts: { biennium: [d.biennium ?? 'none'] } };
      else delete src.suggest;
      body.push({ index: { _index: this.indexFor(d), _id: id } }, src);
    }
    const res = await this.client.bulk({ body: body as any, refresh: false });
    if (res.body.errors) {
      const first = (res.body.items as any[]).find((i) => i.index?.error);
      throw new Error(`bulk index failed: ${JSON.stringify(first?.index?.error).slice(0, 500)}`);
    }
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.client.deleteByQuery({ index: this.all, body: { query: { ids: { values: ids } } }, refresh: true, conflicts: 'proceed' });
  }

  async removeWhere(filter: { bill_key?: string; doc_type?: DocType; note_id?: string }): Promise<void> {
    const must: unknown[] = [];
    if (filter.bill_key) must.push({ term: { bill_key: filter.bill_key } });
    if (filter.doc_type) must.push({ term: { doc_type: filter.doc_type } });
    if (filter.note_id) must.push({ term: { note_id: filter.note_id } });
    if (!must.length) return;
    await this.client.deleteByQuery({ index: this.all, body: { query: { bool: { must } } } as any, refresh: true, conflicts: 'proceed' });
  }

  async refresh(): Promise<void> {
    await this.client.indices.refresh({ index: this.all });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const h = await this.client.cluster.health({ timeout: '2s' });
      const status = h.body.status as string;
      return { ok: status === 'green' || status === 'yellow', detail: status };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async get(ids: string[], principal: Principal): Promise<SearchDoc[]> {
    if (!ids.length) return [];
    const res = await this.client.search({ index: this.all, body: { query: { bool: { must: [{ ids: { values: ids } }], filter: [permissionClause(principal)] } }, size: ids.length } });
    return (res.body.hits.hits as any[]).map((h) => ({ id: h._id, ...h._source }));
  }

  async listByBill(billKey: string, docTypes: DocType[], principal: Principal, size = 50): Promise<SearchDoc[]> {
    const res = await this.client.search({
      index: this.all,
      body: { query: { bool: { filter: [{ term: { bill_key: billKey } }, { terms: { doc_type: docTypes } }, permissionClause(principal)] } }, sort: [{ updated_at: 'desc' }], size, _source: { excludes: ['text', 'body', 'history_text', 'suggest'] } } as any,
    });
    return (res.body.hits.hits as any[]).map((h) => ({ id: h._id, ...h._source }));
  }

  private filters(req: SearchRequest, principal: Principal): unknown[] {
    const f = req.filters;
    const out: unknown[] = [permissionClause(principal)];
    if (f.biennium && f.biennium !== 'all') out.push({ term: { biennium: f.biennium } });
    if (f.chamber) out.push({ term: { chamber: f.chamber } });
    if (f.type?.length) out.push({ terms: { type: f.type } });
    if (f.status?.length) out.push({ terms: { status: f.status } });
    if (f.committee) out.push({ term: { 'committee.name': f.committee } });
    if (f.sponsor) out.push({ bool: { should: [{ term: { 'sponsors.last_name': f.sponsor } }, { term: { 'sponsors.people_id': f.sponsor } }, { match: { sponsor_names: f.sponsor } }], minimum_should_match: 1 } });
    if (f.has_fiscal_note !== undefined) out.push({ term: { has_fiscal_note: f.has_fiscal_note } });
    if (f.fiscal_note_status?.length) out.push({ terms: { fiscal_note_status: f.fiscal_note_status } });
    if (f.doc_type?.length) out.push({ terms: { doc_type: f.doc_type } });
    if (f.rcw_cites?.length) out.push({ terms: { rcw_cites: f.rcw_cites } });
    if (f.rcw_chapters?.length) out.push({ terms: { rcw_chapters: f.rcw_chapters } });
    if (f.rcw_titles?.length) out.push({ terms: { rcw_titles: f.rcw_titles } });
    if (f.version_code) out.push({ term: { version_code: f.version_code } });
    if (f.bill_key) out.push({ term: { bill_key: f.bill_key } });
    if (f.date_from || f.date_to) out.push({ range: { last_action_date: { ...(f.date_from ? { gte: f.date_from } : {}), ...(f.date_to ? { lte: f.date_to } : {}) } } });
    if (f.assigned_to_me) out.push({ term: { assigned_user_ids: principal.userId } });
    return out;
  }

  async search(req: SearchRequest, principal: Principal): Promise<SearchResult> {
    const started = Date.now();
    const filter = this.filters(req, principal);
    const q = req.q.trim();
    const must: unknown[] = q
      ? [
          {
            bool: {
              should: [
                {
                  multi_match: {
                    query: q,
                    type: 'best_fields',
                    operator: 'and',
                    fields: ['bill_number^5', 'bill_number_forms^5', 'title^3', 'heading^2', 'sponsor_names^2', 'sponsors.name^2', 'added_text^1.5', 'text', 'body', 'description', 'caption', 'name', 'history_text^0.5', 'last_action^0.5'],
                    fuzziness: 'AUTO:4,7',
                    prefix_length: 2,
                  },
                },
                { multi_match: { query: q, type: 'phrase', slop: 2, fields: ['title.shingles^3', 'title^3', 'heading^2', 'text', 'body'], boost: 2 } },
              ],
              minimum_should_match: 1,
            },
          },
        ]
      : [];
    const sort = req.sort === 'date' ? [{ last_action_date: { order: 'desc', missing: '_last' } }, '_score'] : req.sort === 'bill_number' ? [{ bill_number: 'asc' }, '_score'] : q ? ['_score'] : [{ last_action_date: { order: 'desc', missing: '_last' } }];
    const body = {
      size: req.size,
      from: (req.page - 1) * req.size,
      track_total_hits: true,
      indices_boost: [{ [this.alias('bill')]: 2.0 }, { [this.alias('fiscal_note')]: 1.5 }, { [this.alias('section')]: 1.0 }, { [this.alias('amendment')]: 0.9 }, { [this.alias('rcw_section')]: 0.8 }, { [this.alias('template')]: 0.7 }],
      query: { bool: { must, filter, should: [{ term: { is_latest_version: { value: true, boost: 1.5 } } }, { range: { last_action_date: { gte: 'now-30d', boost: 1.2 } } }] } },
      sort,
      collapse: { field: 'bill_key', inner_hits: { name: 'per_bill', size: 3, _source: ['doc_type', 'version_label', 'section_no', 'heading', 'url', 'display'], highlight: { pre_tags: ['<mark>'], post_tags: ['</mark>'], fields: { text: { fragment_size: 160, number_of_fragments: 1 }, body: { fragment_size: 160, number_of_fragments: 1 } } } } },
      highlight: { type: 'unified', pre_tags: ['<mark>'], post_tags: ['</mark>'], fields: HIGHLIGHT_FIELDS },
      aggs: {
        doc_type: { terms: { field: 'doc_type' } },
        biennium: { terms: { field: 'biennium' } },
        chamber: { terms: { field: 'chamber' } },
        status: { terms: { field: 'status', size: 10 } },
        committee: { terms: { field: 'committee.name', size: 30 } },
        has_fiscal_note: { terms: { field: 'has_fiscal_note' } },
        fiscal_note_status: { terms: { field: 'fiscal_note_status' } },
        sponsor: { terms: { field: 'sponsors.last_name', size: 20 } },
        rcw_title: { terms: { field: 'rcw_titles', size: 20 } },
      },
      _source: { excludes: ['text', 'body', 'history_text', 'suggest', 'affected_by'] },
    };
    // Documents without a bill_key (templates, RCW sections) collapse into one group; search them separately.
    const withBill = [this.alias('bill'), this.alias('section'), this.alias('amendment'), this.alias('fiscal_note')].join(',');
    const noBill = [this.alias('rcw_section'), this.alias('template')].join(',');
    const res = await this.client.msearch({
      body: [
        { index: withBill },
        body,
        { index: noBill },
        { ...body, collapse: undefined, aggs: undefined, size: Math.min(5, req.size) },
      ] as any,
    });
    const [main, extra] = res.body.responses as any[];
    if (main.error) throw new Error(JSON.stringify(main.error).slice(0, 500));
    const hits: SearchHit[] = (main.hits.hits as any[]).map((h) => this.toHit(h));
    if (!extra.error) for (const h of extra.hits.hits as any[]) hits.push(this.toHit(h));
    hits.sort((a, b) => b.score - a.score);
    const facets: Record<string, Facet[]> = {};
    for (const [k, v] of Object.entries(main.aggregations ?? {})) {
      facets[k] = ((v as any).buckets as any[]).map((b) => ({ key: String(b.key_as_string ?? b.key), count: b.doc_count }));
    }
    return { hits, facets, total: main.hits.total.value + (extra.error ? 0 : extra.hits.total.value), took_ms: Date.now() - started };
  }

  private toHit(h: any): SearchHit {
    const s = h._source ?? {};
    const inner = h.inner_hits?.per_bill?.hits?.hits as any[] | undefined;
    const hit: SearchHit = {
      id: h._id,
      doc_type: s.doc_type,
      score: h._score ?? 0,
      bill_key: s.bill_key ?? null,
      display: s.display ?? null,
      title: s.title ?? null,
      version_code: s.version_code ?? null,
      version_label: s.version_label ?? null,
      section_no: s.section_no ?? null,
      heading: s.heading ?? null,
      status: s.status ?? null,
      url: s.url ?? null,
      extra: { last_action: s.last_action, last_action_date: s.last_action_date, committee: s.committee?.name, sponsor: s.sponsors?.[0]?.name, note_id: s.note_id, source: s.source, cite: s.cite, caption: s.caption, fiscal_note_status: s.fiscal_note_status },
    };
    if (h.highlight) hit.highlight = h.highlight;
    if (inner && inner.length > 1) {
      hit.inner_hits = inner
        .filter((i) => i._id !== h._id)
        .map((i) => ({ id: i._id, doc_type: i._source?.doc_type, section_no: i._source?.section_no ?? null, heading: i._source?.heading ?? null, version_label: i._source?.version_label ?? null, url: i._source?.url ?? null, highlight: i.highlight }));
    }
    return hit;
  }

  async suggest(q: string, biennium: string, principal: Principal, size: number): Promise<Suggestion[]> {
    const res = await this.client.msearch({
      body: [
        { index: this.alias('bill') },
        {
          suggest: { billnum: { prefix: q, completion: { field: 'suggest', size: Math.min(size, 6), skip_duplicates: true, fuzzy: { fuzziness: 1, prefix_length: 2 }, contexts: { biennium: [{ context: biennium }] } } } },
          _source: ['bill_key', 'display', 'title', 'latest_version_code', 'version_label', 'status', 'url'],
          size: 0,
        },
        { index: `${this.alias('bill')},${this.alias('fiscal_note')}` },
        {
          query: { bool: { must: [{ multi_match: { query: q, type: 'bool_prefix', fields: ['title.sayt', 'title.sayt._2gram', 'title.sayt._3gram'] } }], filter: [{ term: { biennium } }, permissionClause(principal)] } },
          size,
          _source: ['doc_type', 'bill_key', 'display', 'title', 'status', 'note_id', 'url', 'version_label', 'latest_version_code'],
        },
      ] as any,
    });
    const [comp, sayt] = res.body.responses as any[];
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const push = (s: Suggestion) => {
      const key = s.bill_key ?? s.note_id ?? s.display ?? '';
      if (seen.has(key)) return;
      seen.add(key);
      out.push(s);
    };
    for (const opt of comp?.suggest?.billnum?.[0]?.options ?? []) {
      const s = opt._source ?? {};
      push({ kind: 'bill', bill_key: s.bill_key, display: s.display, label: s.version_label ?? s.display, title: s.title, status: s.status, url: s.url });
    }
    for (const h of sayt?.hits?.hits ?? []) {
      const s = h._source ?? {};
      if (s.doc_type === 'bill') push({ kind: 'bill', bill_key: s.bill_key, display: s.display, label: s.version_label ?? s.display, title: s.title, status: s.status, url: s.url });
      else push({ kind: 'fiscal_note', note_id: s.note_id, bill_key: s.bill_key, display: s.display, title: s.title, status: s.status, url: s.url });
    }
    return out.slice(0, size);
  }
}
