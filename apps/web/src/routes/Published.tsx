import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { listPublished, type PublishedItem } from '../lib/listApi';
import '../notes/notes.css';

const FORMATS = ['pdf', 'docx', 'html', 'xml'] as const;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'short', day: 'numeric' });
}

function exportHref(item: PublishedItem, format: (typeof FORMATS)[number]): string {
  return item.exports?.[format] ?? `/api/v1/notes/${item.revisionId}/export?format=${format}`;
}

/** `/published`: published notes newest first with the four export links. */
export function Published() {
  const { principal } = useSession();
  const [items, setItems] = useState<PublishedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (after: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const page = await listPublished(after);
      const next = Array.isArray(page?.items) ? page.items : [];
      setItems((prev) => (after && prev ? [...prev, ...next] : next));
      setCursor(page?.nextCursor ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'Published · Fiscal Note Workbench';
  }, []);
  useEffect(() => {
    if (principal) void load(null);
  }, [principal, load]);

  return (
    <RequireRole roles={[]}>
      <section className="published-page" aria-labelledby="published-h">
        <h1 id="published-h">Published fiscal notes</h1>
        <p className="muted">Newest first. Each note is frozen at its published version and exports in four formats.</p>
        {error && <p role="alert">{error}</p>}
        {!items && !error && (
          <p aria-live="polite" className="muted">
            Loading…
          </p>
        )}
        {items && items.length === 0 && <p className="muted">Nothing has been published yet.</p>}
        {items && items.length > 0 && (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Published notes, scrolls horizontally on narrow screens">
            <table className="published-table">
              <thead>
                <tr>
                  <th scope="col">Bill</th>
                  <th scope="col">Version</th>
                  <th scope="col">Title</th>
                  <th scope="col">Published</th>
                  <th scope="col">Exports</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const bill = it.bill ?? ({} as Partial<PublishedItem['bill']>);
                  const billHref = bill.biennium && bill.billId ? `/bills/${bill.biennium}/${bill.billId}${it.versionCode ? `/${it.versionCode}` : ''}` : null;
                  const billLabel = bill.number ?? bill.billId ?? '—';
                  return (
                    <tr key={it.revisionId ?? i}>
                      <td>
                        {billHref ? <Link to={billHref}>{billLabel}</Link> : billLabel}
                        {bill.title && <div className="muted small">{bill.title}</div>}
                      </td>
                      <td>{it.versionCode ?? '—'}</td>
                      <td>
                        {it.revisionId ? <Link to={`/notes/${it.revisionId}`}>{it.title || 'Fiscal note'}</Link> : it.title || 'Fiscal note'}
                        {it.publishedVersion != null && <div className="muted small">version {it.publishedVersion}</div>}
                      </td>
                      <td>
                        {fmtDate(it.publishedAt)}
                        {it.publishedBy?.displayName && <div className="muted small">by {it.publishedBy.displayName}</div>}
                      </td>
                      <td>
                        <span className="row export-links" role="group" aria-label={`Export ${billLabel}`}>
                          {FORMATS.map((f) => (
                            <a key={f} className="button secondary" href={exportHref(it, f)} target={f === 'docx' ? undefined : '_blank'} rel="noreferrer">
                              {f.toUpperCase()}
                            </a>
                          ))}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {cursor && (
          <p>
            <button type="button" className="secondary" disabled={busy} onClick={() => void load(cursor)}>
              Load more
            </button>
          </p>
        )}
      </section>
    </RequireRole>
  );
}
