import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, type ApiError } from '../lib/api';
import { RequireRole } from '../components/RequireRole';

interface Hit {
  id: string;
  doc_type: string;
  score: number;
  bill_key?: string | null;
  display?: string | null;
  title?: string | null;
  version_label?: string | null;
  section_no?: string | null;
  heading?: string | null;
  status?: string | null;
  url?: string | null;
  highlight?: Record<string, string[]>;
  inner_hits?: { id: string; doc_type: string; section_no?: string | null; heading?: string | null; version_label?: string | null; url?: string | null; highlight?: Record<string, string[]> }[];
  extra?: Record<string, unknown>;
}

interface SearchResponse {
  query: string;
  parsed: Record<string, unknown> | null;
  direct: {
    kind: string;
    bill_key?: string;
    display?: string;
    title?: string;
    resolved_version_label?: string;
    url?: string | null;
    external_url?: string;
    ambiguous: boolean;
    candidates: { bill_key: string; display: string; title?: string; url: string }[];
    warnings: string[];
    related?: { amendments: { amendment_id: string; url?: string | null }[]; companion: { display: string; url: string } | null; fiscal_notes: { note_id: string; title?: string | null; status?: string | null; url?: string | null; source?: string }[]; rcw: { cite: string; action: string }[] };
  } | null;
  hits: Hit[];
  facets: Record<string, { key: string; count: number }[]>;
  page: number;
  size: number;
  total: number;
  took_ms: number;
  backend: string;
}

const FACET_LABELS: Record<string, string> = { doc_type: 'Document type', chamber: 'Chamber', status: 'Status', committee: 'Committee', has_fiscal_note: 'Has fiscal note', fiscal_note_status: 'Fiscal note status', sponsor: 'Sponsor', rcw_title: 'RCW title' };
const FACET_PARAM: Record<string, string> = { doc_type: 'doc_type', chamber: 'chamber', status: 'status', committee: 'committee', has_fiscal_note: 'has_fiscal_note', fiscal_note_status: 'fiscal_note_status', sponsor: 'sponsor', rcw_title: 'rcw' };
const DOC_LABEL: Record<string, string> = { bill: 'Bill', section: 'Bill section', amendment: 'Amendment', fiscal_note: 'Fiscal note', rcw_section: 'RCW section', template: 'Template' };

function Highlight({ html }: { html: string }) {
  // Highlights come from the API with <mark> only; strip anything else.
  const safe = html.replace(/<(?!\/?mark>)[^>]*>/g, '');
  return <span dangerouslySetInnerHTML={{ __html: safe }} />;
}

export function SearchResults() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [data, setData] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = params.toString();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query: Record<string, string> = {};
    params.forEach((v, k) => (query[k] = v));
    api<SearchResponse>('/search', { query })
      .then((d) => !cancelled && setData(d))
      .catch((e: ApiError) => !cancelled && setError(e.status === 503 ? 'Search is unavailable right now.' : e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(() => {
    document.title = `${q ? `"${q}"` : 'Search'} · Fiscal Note Workbench`;
  }, [q]);

  const activeFilters = useMemo(() => {
    const out: { param: string; value: string }[] = [];
    params.forEach((v, k) => {
      if (k !== 'q' && k !== 'page' && k !== 'sort') out.push({ param: k, value: v });
    });
    return out;
  }, [params]);

  const setFilter = (param: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(param);
    else next.set(param, value);
    next.delete('page');
    setParams(next);
  };

  const d = data?.direct;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <RequireRole roles={[]}>
      <div className="search-page">
        <h1>
          Search{q ? <>: <q>{q}</q></> : ''}
        </h1>
        {error && <p role="alert">{error}</p>}
        {loading && !data && <p aria-live="polite">Searching…</p>}
        {d && (
          <section className="direct-card" aria-labelledby="direct-h">
            <h2 id="direct-h" className="visually-hidden">
              Direct match
            </h2>
            {d.url ? (
              <p>
                <strong>
                  <Link to={d.url}>
                    {d.resolved_version_label ?? d.display}
                  </Link>
                </strong>
                {d.title && <span className="muted"> · {d.title}</span>}
                {d.warnings.length > 0 && <span className="warn"> ({d.warnings.join('; ')})</span>}
              </p>
            ) : d.ambiguous ? (
              <p>
                Did you mean{' '}
                {d.candidates.map((c, i) => (
                  <span key={c.bill_key}>
                    {i > 0 && ', '}
                    <Link to={c.url}>{c.display}</Link>
                  </span>
                ))}
                ?
              </p>
            ) : d.external_url ? (
              <p>
                <a href={d.external_url} target="_blank" rel="noreferrer">
                  {d.display} on leg.wa.gov
                </a>
                {d.warnings.length > 0 && <span className="muted"> · {d.warnings.join('; ')}</span>}
              </p>
            ) : (
              <p>
                No bill found for {d.display ?? q}.{d.warnings.length > 0 && <span className="muted"> {d.warnings.join('; ')}</span>}
              </p>
            )}
            {d.related && (
              <ul className="related">
                {d.related.companion && (
                  <li>
                    Companion: <Link to={d.related.companion.url}>{d.related.companion.display}</Link>
                  </li>
                )}
                {d.related.fiscal_notes.length > 0 && (
                  <li>
                    Fiscal notes:{' '}
                    {d.related.fiscal_notes.map((n, i) => (
                      <span key={n.note_id}>
                        {i > 0 && ', '}
                        {n.url?.startsWith('/') ? <Link to={n.url}>{n.title ?? n.note_id}</Link> : <a href={n.url ?? '#'} target="_blank" rel="noreferrer">{n.title ?? n.note_id}</a>}
                        {n.status && <span className="muted"> ({n.status})</span>}
                      </span>
                    ))}
                  </li>
                )}
                {d.related.amendments.length > 0 && <li>{d.related.amendments.length} amendments</li>}
                {d.related.rcw.length > 0 && <li>RCW: {d.related.rcw.map((r) => r.cite).join(', ')}</li>}
              </ul>
            )}
          </section>
        )}
        <div className="search-layout">
          <aside className="facets" aria-label="Filters">
            {activeFilters.length > 0 && (
              <div className="active-filters">
                {activeFilters.map((f) => (
                  <button key={f.param} type="button" className="chip" onClick={() => setFilter(f.param, null)} aria-label={`Remove filter ${f.param}: ${f.value}`}>
                    {f.param}: {f.value} ✕
                  </button>
                ))}
              </div>
            )}
            {data &&
              Object.entries(data.facets)
                .filter(([k, v]) => FACET_LABELS[k] && v.length > 0 && k !== 'biennium')
                .map(([k, values]) => (
                  <details key={k} open={['doc_type', 'chamber', 'status'].includes(k)}>
                    <summary>{FACET_LABELS[k]}</summary>
                    <ul>
                      {values.slice(0, 12).map((v) => (
                        <li key={v.key}>
                          <button type="button" className="linkish" onClick={() => setFilter(FACET_PARAM[k]!, v.key)} aria-pressed={params.get(FACET_PARAM[k]!) === v.key}>
                            {k === 'doc_type' ? DOC_LABEL[v.key] ?? v.key : v.key} <span className="muted">({v.count})</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
          </aside>
          <section className="results" aria-labelledby="results-h">
            <h2 id="results-h" className="results-h">
              {data ? `${data.total} result${data.total === 1 ? '' : 's'}` : ''}
              {data && <span className="muted small"> · {data.took_ms} ms · {data.backend}</span>}
            </h2>
            {data && (
              <label className="sort">
                Sort{' '}
                <select value={params.get('sort') ?? 'relevance'} onChange={(e) => setFilter('sort', e.target.value)}>
                  <option value="relevance">Relevance</option>
                  <option value="date">Last action</option>
                  <option value="bill_number">Bill number</option>
                </select>
              </label>
            )}
            <ol className="hits">
              {data?.hits.map((h) => (
                <li key={h.id} className={`hit hit-${h.doc_type}`}>
                  <div className="hit-head">
                    <span className="badge">{DOC_LABEL[h.doc_type] ?? h.doc_type}</span>{' '}
                    {h.url?.startsWith('/') ? (
                      <Link to={h.url}>
                        <strong>{h.version_label ?? h.display}</strong>
                        {h.section_no && <> · Sec. {h.section_no}</>}
                      </Link>
                    ) : (
                      <a href={h.url ?? '#'} target="_blank" rel="noreferrer">
                        <strong>{h.display ?? h.title}</strong>
                      </a>
                    )}
                    {h.title && h.doc_type !== 'rcw_section' && <span className="hit-title"> {h.highlight?.title ? <Highlight html={h.highlight.title[0]!} /> : h.title}</span>}
                    {h.status && <span className="muted"> · {h.status.replace(/_/g, ' ')}</span>}
                  </div>
                  {h.heading && h.doc_type === 'section' && <div className="muted small">{h.heading}</div>}
                  {h.highlight && (h.highlight.text ?? h.highlight.body ?? h.highlight.description) && (
                    <p className="snippet">
                      {(h.highlight.text ?? h.highlight.body ?? h.highlight.description ?? []).map((frag, i) => (
                        <span key={i}>
                          … <Highlight html={frag} /> …{' '}
                        </span>
                      ))}
                    </p>
                  )}
                  {h.inner_hits && h.inner_hits.length > 0 && (
                    <ul className="inner">
                      {h.inner_hits.map((ih) => (
                        <li key={ih.id}>
                          {ih.url?.startsWith('/') ? <Link to={ih.url}>{ih.doc_type === 'section' ? `Sec. ${ih.section_no}` : DOC_LABEL[ih.doc_type] ?? ih.doc_type}</Link> : <span>{DOC_LABEL[ih.doc_type] ?? ih.doc_type}</span>}
                          {ih.heading && <span className="muted"> {ih.heading.slice(0, 90)}</span>}
                          {ih.highlight?.text?.[0] && (
                            <span className="snippet">
                              {' '}
                              … <Highlight html={ih.highlight.text[0]} /> …
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            {data && data.total === 0 && !d && <p>No results. Try a bill number (HB 2402), an RCW cite (82.04.260), or different words.</p>}
            {data && pages > 1 && (
              <nav className="pager" aria-label="Pages">
                <button type="button" className="secondary" disabled={data.page <= 1} onClick={() => setFilter('page', String(data.page - 1))}>
                  Previous
                </button>
                <span>
                  Page {data.page} of {pages}
                </span>
                <button type="button" className="secondary" disabled={data.page >= pages} onClick={() => setFilter('page', String(data.page + 1))}>
                  Next
                </button>
              </nav>
            )}
          </section>
        </div>
      </div>
    </RequireRole>
  );
}
