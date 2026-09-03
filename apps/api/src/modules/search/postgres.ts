// Postgres full-text implementation of SearchBackend (search.md section 7.2). Same response shape as OpenSearch.
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Principal } from '../identity/index.js';
import type { DocType, Facet, SearchBackend, SearchDoc, SearchHit, SearchRequest, SearchResult, Suggestion } from './backend.js';
import { pgTextArray } from '../../lib/sql.js';
import { expandSynonyms } from './synonyms.js';

const DOC_TYPE_WEIGHT: Record<DocType, number> = { bill: 2.0, fiscal_note: 1.5, section: 1.0, amendment: 0.9, rcw_section: 0.8 };

function toQuery(q: string): string {
  // websearch_to_tsquery handles quotes and OR; synonyms are expanded as OR alternatives.
  const forms = expandSynonyms(q);
  return forms.length === 1 ? forms[0]! : forms.map((f) => `(${f})`).join(' OR ');
}

export class PostgresBackend implements SearchBackend {
  readonly name = 'postgres' as const;
  constructor(private readonly db: Db) {}

  async init(): Promise<void> {
    /* tables come from migrations */
  }

  async index(docs: SearchDoc[]): Promise<void> {
    for (const d of docs) {
      const payload = { ...d } as Record<string, unknown>;
      delete payload.body;
      delete payload.text;
      delete payload.history_text;
      const body = [d.body, d.text, d.description, d.history_text, d.sponsor_names, d.caption].filter(Boolean).join('\n');
      await this.db.execute(sql`INSERT INTO search_docs (id, doc_type, bill_key, biennium, chamber, type, bill_number, display, status, committee, has_fiscal_note,
          fiscal_note_status, visibility, allowed_roles, allowed_user_ids, rcw_cites, rcw_chapters, rcw_titles, sponsor_last_names,
          version_code, version_label, is_latest_version, last_action_date, title, heading, body, bill_number_forms, payload, updated_at, source_hash)
        VALUES (${d.id}, ${d.doc_type}, ${d.bill_key ?? null}, ${d.biennium ?? null}, ${d.chamber ?? null}, ${d.type ?? null}, ${d.bill_number ?? null}, ${d.display ?? null},
          ${d.status ?? null}, ${d.committee?.name ?? null}, ${d.has_fiscal_note ?? false}, ${d.fiscal_note_status ?? null}, ${d.visibility},
          ${pgTextArray(d.allowed_roles)}::text[], ${pgTextArray(d.allowed_user_ids)}::text[],
          ${pgTextArray(d.rcw_cites ?? [])}::text[], ${pgTextArray(d.rcw_chapters ?? [])}::text[], ${pgTextArray(d.rcw_titles ?? [])}::text[],
          ${pgTextArray((d.sponsors ?? []).map((s) => s.last_name ?? '').filter(Boolean))}::text[],
          ${d.version_code ?? null}, ${d.version_label ?? null}, ${d.is_latest_version ?? null}, ${d.last_action_date ?? null},
          ${d.title ?? null}, ${d.heading ?? null}, ${body}, ${pgTextArray((d.bill_number_forms ?? []).map((f) => f.toUpperCase()))}::text[],
          ${JSON.stringify(payload)}::jsonb, ${d.updated_at}::timestamptz, ${d.source_hash ?? null})
        ON CONFLICT (id) DO UPDATE SET doc_type = EXCLUDED.doc_type, bill_key = EXCLUDED.bill_key, biennium = EXCLUDED.biennium, chamber = EXCLUDED.chamber,
          type = EXCLUDED.type, bill_number = EXCLUDED.bill_number, display = EXCLUDED.display, status = EXCLUDED.status, committee = EXCLUDED.committee,
          has_fiscal_note = EXCLUDED.has_fiscal_note, fiscal_note_status = EXCLUDED.fiscal_note_status, visibility = EXCLUDED.visibility,
          allowed_roles = EXCLUDED.allowed_roles, allowed_user_ids = EXCLUDED.allowed_user_ids,
          rcw_cites = EXCLUDED.rcw_cites, rcw_chapters = EXCLUDED.rcw_chapters, rcw_titles = EXCLUDED.rcw_titles, sponsor_last_names = EXCLUDED.sponsor_last_names,
          version_code = EXCLUDED.version_code, version_label = EXCLUDED.version_label, is_latest_version = EXCLUDED.is_latest_version,
          last_action_date = EXCLUDED.last_action_date, title = EXCLUDED.title, heading = EXCLUDED.heading, body = EXCLUDED.body,
          bill_number_forms = EXCLUDED.bill_number_forms, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at, source_hash = EXCLUDED.source_hash`);
    }
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.execute(sql`DELETE FROM search_docs WHERE id = ANY(${pgTextArray(ids)}::text[])`);
  }

  async removeWhere(filter: { bill_key?: string; doc_type?: DocType; note_id?: string; exceptIds?: string[] }): Promise<void> {
    const conds: SQL[] = [];
    if (filter.exceptIds?.length) conds.push(sql`NOT (id = ANY(${pgTextArray(filter.exceptIds)}::text[]))`);
    if (filter.bill_key) conds.push(sql`bill_key = ${filter.bill_key}`);
    if (filter.doc_type) conds.push(sql`doc_type = ${filter.doc_type}`);
    if (filter.note_id) conds.push(sql`payload->>'note_id' = ${filter.note_id}`);
    if (!conds.length) return;
    await this.db.execute(sql`DELETE FROM search_docs WHERE ${sql.join(conds, sql` AND `)}`);
  }

  async refresh(): Promise<void> {
    /* no-op */
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.db.execute(sql`SELECT 1 FROM search_docs LIMIT 1`);
      return { ok: true, detail: 'postgres' };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  private permission(p: Principal): SQL {
    return sql`(visibility = 'public' OR allowed_roles && ${pgTextArray(p.roles)}::text[] OR ${p.userId} = ANY(allowed_user_ids))`;
  }

  async get(ids: string[], principal: Principal): Promise<SearchDoc[]> {
    if (!ids.length) return [];
    const rows = (await this.db.execute(sql`SELECT id, payload, body FROM search_docs WHERE id = ANY(${pgTextArray(ids)}::text[]) AND ${this.permission(principal)}`)).rows as any[];
    return rows.map((r) => ({ ...(r.payload as SearchDoc), id: r.id, body: r.body }));
  }

  async listByBill(billKey: string, docTypes: DocType[], principal: Principal, size = 50): Promise<SearchDoc[]> {
    const rows = (await this.db.execute(sql`SELECT id, payload FROM search_docs WHERE bill_key = ${billKey} AND doc_type = ANY(${pgTextArray(docTypes)}::text[])
        AND ${this.permission(principal)} ORDER BY updated_at DESC, id LIMIT ${size}`)).rows as any[];
    return rows.map((r) => ({ ...(r.payload as SearchDoc), id: r.id }));
  }

  private filters(req: SearchRequest, principal: Principal): SQL[] {
    const f = req.filters;
    const conds: SQL[] = [this.permission(principal)];
    if (f.biennium && f.biennium !== 'all') conds.push(sql`biennium = ${f.biennium}`);
    if (f.chamber) conds.push(sql`chamber = ${f.chamber}`);
    if (f.type?.length) conds.push(sql`type = ANY(${pgTextArray(f.type)}::text[])`);
    if (f.status?.length) conds.push(sql`status = ANY(${pgTextArray(f.status)}::text[])`);
    if (f.committee) conds.push(sql`committee = ${f.committee}`);
    if (f.sponsor) conds.push(sql`(${f.sponsor} = ANY(sponsor_last_names) OR payload->>'sponsor_names' ILIKE ${'%' + f.sponsor + '%'})`);
    if (f.has_fiscal_note !== undefined) conds.push(sql`has_fiscal_note = ${f.has_fiscal_note}`);
    if (f.fiscal_note_status?.length) conds.push(sql`fiscal_note_status = ANY(${pgTextArray(f.fiscal_note_status)}::text[])`);
    if (f.doc_type?.length) conds.push(sql`doc_type = ANY(${pgTextArray(f.doc_type)}::text[])`);
    if (f.rcw_cites?.length) conds.push(sql`rcw_cites && ${pgTextArray(f.rcw_cites)}::text[]`);
    if (f.rcw_chapters?.length) conds.push(sql`rcw_chapters && ${pgTextArray(f.rcw_chapters)}::text[]`);
    if (f.rcw_titles?.length) conds.push(sql`rcw_titles && ${pgTextArray(f.rcw_titles)}::text[]`);
    if (f.version_code) conds.push(sql`version_code = ${f.version_code}`);
    if (f.bill_key) conds.push(sql`bill_key = ${f.bill_key}`);
    if (f.date_from) conds.push(sql`last_action_date >= ${f.date_from}::date`);
    if (f.date_to) conds.push(sql`last_action_date <= ${f.date_to}::date`);
    return conds;
  }

  async search(req: SearchRequest, principal: Principal): Promise<SearchResult> {
    const started = Date.now();
    const q = req.q.trim();
    const conds = this.filters(req, principal);
    const tsq = q ? sql`websearch_to_tsquery('english', ${toQuery(q)})` : null;
    const upperQ = q.toUpperCase().replace(/\s+/g, ' ');
    if (tsq) conds.push(sql`(tsv @@ ${tsq} OR ${upperQ} = ANY(bill_number_forms) OR title ILIKE ${'%' + q + '%'})`);
    const where = sql.join(conds, sql` AND `);
    const weightCase = sql`CASE doc_type ${sql.join(
      Object.entries(DOC_TYPE_WEIGHT).map(([k, v]) => sql`WHEN ${k} THEN ${v}::float`),
      sql` `,
    )} ELSE 1 END`;
    const rank = tsq
      ? sql`(ts_rank_cd(tsv, ${tsq}, 32) * ${weightCase} + CASE WHEN ${upperQ} = ANY(bill_number_forms) THEN 5 ELSE 0 END + CASE WHEN is_latest_version THEN 0.2 ELSE 0 END)`
      : sql`(0)::float`;
    const order =
      req.sort === 'date'
        ? sql`last_action_date DESC NULLS LAST, rank DESC`
        : req.sort === 'bill_number'
          ? sql`bill_number ASC NULLS LAST, rank DESC`
          : q
            ? sql`rank DESC, updated_at DESC`
            : sql`last_action_date DESC NULLS LAST, updated_at DESC`;
    const offset = (req.page - 1) * req.size;
    const headline = tsq ? sql`ts_headline('english', coalesce(body, ''), ${tsq}, 'MaxFragments=2, MaxWords=30, MinWords=12, StartSel=<mark>, StopSel=</mark>')` : sql`NULL`;
    const rows = (await this.db.execute(sql`
      WITH matched AS (
        SELECT id, doc_type, bill_key, display, title, version_code, version_label, payload->>'section_no' AS section_no, heading, status, payload, body, is_latest_version, last_action_date, updated_at, ${rank} AS rank
        FROM search_docs WHERE ${where}
      ),
      collapsed AS (
        SELECT DISTINCT ON (coalesce(bill_key, id)) * FROM matched ORDER BY coalesce(bill_key, id), rank DESC
      ),
      page AS (
        SELECT * FROM collapsed ORDER BY ${order} LIMIT ${req.size} OFFSET ${offset}
      )
      SELECT p.*, ${headline} AS headline,
        (SELECT count(*) FROM collapsed) AS total,
        (SELECT json_agg(json_build_object('id', m.id, 'doc_type', m.doc_type, 'section_no', m.section_no, 'heading', m.heading, 'version_label', m.version_label, 'url', m.payload->>'url'))
           FROM (SELECT * FROM matched m2 WHERE m2.bill_key = p.bill_key AND m2.id <> p.id AND p.bill_key IS NOT NULL ORDER BY rank DESC LIMIT 2) m) AS inner_hits
      FROM page p ORDER BY ${order}`)).rows as any[];
    const total = rows.length ? Number(rows[0].total) : Number(((await this.db.execute(sql`SELECT count(DISTINCT coalesce(bill_key, id)) AS n FROM search_docs WHERE ${where}`)).rows[0] as any).n);
    const hits: SearchHit[] = rows.map((r) => {
      const p = r.payload as SearchDoc;
      const hit: SearchHit = {
        id: r.id,
        doc_type: r.doc_type,
        score: Number(r.rank ?? 0),
        bill_key: r.bill_key,
        display: r.display,
        title: r.title,
        version_code: r.version_code,
        version_label: r.version_label,
        section_no: r.section_no,
        heading: r.heading,
        status: r.status,
        url: p.url ?? null,
        extra: { last_action: p.last_action, last_action_date: p.last_action_date, committee: p.committee?.name, sponsor: p.sponsors?.[0]?.name, note_id: p.note_id, source: p.source, cite: p.cite, caption: p.caption, fiscal_note_status: p.fiscal_note_status },
      };
      if (r.headline && String(r.headline).includes('<mark>')) hit.highlight = { body: [String(r.headline)] };
      if (r.inner_hits) hit.inner_hits = r.inner_hits;
      return hit;
    });
    const facetRows = (await this.db.execute(sql`
      SELECT 'doc_type' AS facet, doc_type AS key, count(*) AS n FROM search_docs WHERE ${where} GROUP BY doc_type
      UNION ALL SELECT 'biennium', biennium, count(*) FROM search_docs WHERE ${where} AND biennium IS NOT NULL GROUP BY biennium
      UNION ALL SELECT 'chamber', chamber, count(*) FROM search_docs WHERE ${where} AND chamber IS NOT NULL GROUP BY chamber
      UNION ALL SELECT 'status', status, count(*) FROM search_docs WHERE ${where} AND status IS NOT NULL GROUP BY status
      UNION ALL SELECT 'committee', committee, count(*) FROM search_docs WHERE ${where} AND committee IS NOT NULL GROUP BY committee
      UNION ALL SELECT 'has_fiscal_note', has_fiscal_note::text, count(*) FROM search_docs WHERE ${where} GROUP BY has_fiscal_note
      UNION ALL SELECT 'fiscal_note_status', fiscal_note_status, count(*) FROM search_docs WHERE ${where} AND fiscal_note_status IS NOT NULL GROUP BY fiscal_note_status
      UNION ALL SELECT 'sponsor', s, count(*) FROM search_docs, unnest(sponsor_last_names) s WHERE ${where} GROUP BY s
      UNION ALL SELECT 'rcw_title', t, count(*) FROM search_docs, unnest(rcw_titles) t WHERE ${where} GROUP BY t`)).rows as any[];
    const facets: Record<string, Facet[]> = {};
    for (const r of facetRows) {
      (facets[r.facet] ??= []).push({ key: String(r.key), count: Number(r.n) });
    }
    for (const k of Object.keys(facets)) facets[k]!.sort((a, b) => b.count - a.count);
    for (const k of ['committee', 'sponsor', 'rcw_title']) if (facets[k]) facets[k] = facets[k]!.slice(0, 30);
    return { hits, facets, total, took_ms: Date.now() - started };
  }

  async suggest(q: string, biennium: string, principal: Principal, size: number): Promise<Suggestion[]> {
    const upper = q.toUpperCase().replace(/\s+/g, ' ');
    const rows = (await this.db.execute(sql`
      SELECT id, doc_type, bill_key, display, title, status, version_label, payload->>'url' AS url, payload->>'note_id' AS note_id,
        CASE WHEN EXISTS (SELECT 1 FROM unnest(bill_number_forms) f WHERE f LIKE ${upper + '%'}) THEN 2 ELSE similarity(title, ${q}) END AS score
      FROM search_docs
      WHERE doc_type IN ('bill', 'fiscal_note') AND biennium = ${biennium} AND ${this.permission(principal)}
        AND (EXISTS (SELECT 1 FROM unnest(bill_number_forms) f WHERE f LIKE ${upper + '%'}) OR title ILIKE ${'%' + q + '%'} OR title % ${q})
      ORDER BY score DESC, bill_number LIMIT ${size}`)).rows as any[];
    return rows.map((r) => (r.doc_type === 'bill' ? { kind: 'bill', bill_key: r.bill_key, display: r.display, label: r.version_label ?? r.display, title: r.title, status: r.status, url: r.url } : { kind: 'fiscal_note', note_id: r.note_id, bill_key: r.bill_key, display: r.display, title: r.title, status: r.status, url: r.url }));
  }
}
