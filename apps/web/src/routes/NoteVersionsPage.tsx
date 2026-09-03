import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { docToHtml } from '@wa-leg/note-schema';
import { RequireRole } from '../components/RequireRole';
import { fmtWhen, notesApi, useResource, type NoteDiff, type NoteDocument } from '../notes/api';
import '../notes/notes.css';

/** Version history: list newest first, view a version, compare two versions as a redline plus a cell diff, restore. */
export function NoteVersionsPage() {
  const { revisionId } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const summary = useResource(revisionId ? () => notesApi.summary(revisionId) : null, [revisionId]);
  const versions = useResource(revisionId ? () => notesApi.versions(revisionId) : null, [revisionId]);
  // A change request links here with ?from=&to= to show the edits that answered it.
  const [from, setFrom] = useState<number | null>(params.get('from') ? Number(params.get('from')) : null);
  const [to, setTo] = useState<number | null>(params.get('to') ? Number(params.get('to')) : null);
  const [diff, setDiff] = useState<NoteDiff | null>(null);
  const [view, setView] = useState<NoteDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (summary.data) document.title = `${summary.data.versionLabel} note versions · Fiscal Note Workbench`;
  }, [summary.data]);

  useEffect(() => {
    if (!revisionId || from === null || to === null || from === to) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    notesApi
      .diff(revisionId, Math.min(from, to), Math.max(from, to))
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [revisionId, from, to]);

  if (!revisionId) return <p role="alert">Missing note id.</p>;
  const rows = versions.data ?? [];
  const head = rows[0]?.version ?? null;

  const compareWith = (v: number, other: number | null) => {
    setView(null);
    setFrom(other ?? v);
    setTo(v);
  };
  const restore = async (v: number) => {
    setBusy(true);
    try {
      await notesApi.restore(revisionId, v);
      await versions.reload();
      setView(null);
      setDiff(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const snapshot = async () => {
    setBusy(true);
    try {
      await notesApi.snapshot(revisionId, label || undefined);
      setLabel('');
      await versions.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openView = async (v: number) => {
    setDiff(null);
    setFrom(null);
    setTo(null);
    setView(await notesApi.document(revisionId, v));
  };

  return (
    <RequireRole roles={[]}>
      <div className="versions-page">
        <nav aria-label="Breadcrumb" className="crumbs">
          <Link to={`/notes/${revisionId}`}>← Back to the note</Link>
        </nav>
        <h1>{summary.data ? `${summary.data.versionLabel} fiscal note: versions` : 'Versions'}</h1>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="versions-layout">
          <section aria-labelledby="vlist-h" className="version-list">
            <h2 id="vlist-h">History</h2>
            {summary.data?.editable && (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void snapshot();
                }}
              >
                <label className="inline">
                  Label
                  <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Before review" />
                </label>
                <button type="submit" disabled={busy}>
                  Save version
                </button>
              </form>
            )}
            <table>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Label</th>
                  <th scope="col">By</th>
                  <th scope="col">When</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.version} className={r.version === to ? 'selected' : undefined}>
                    <td>
                      {r.version}
                      {r.version === head && <span className="muted"> (head)</span>}
                    </td>
                    <td>
                      {r.label ?? <span className="muted">autosave</span>}
                      {r.summary && <div className="muted small">{r.summary}</div>}
                    </td>
                    <td>{r.createdByName ?? r.createdBy}</td>
                    <td>{fmtWhen(r.createdAt)}</td>
                    <td className="actions">
                      <button type="button" className="linkish" onClick={() => void openView(r.version)}>
                        View
                      </button>
                      {r.version !== head && (
                        <button type="button" className="linkish" onClick={() => compareWith(r.version, head)}>
                          Compare with current
                        </button>
                      )}
                      {rows[i + 1] && (
                        <button type="button" className="linkish" onClick={() => compareWith(r.version, rows[i + 1]!.version)}>
                          Compare with previous
                        </button>
                      )}
                      {r.version !== head && summary.data?.editable && (
                        <button type="button" className="linkish" onClick={() => void restore(r.version)} disabled={busy}>
                          Restore
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !versions.loading && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No versions yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
          <section aria-labelledby="vdetail-h" className="version-detail" aria-busy={busy}>
            <h2 id="vdetail-h">
              {view ? `Version ${view.version}` : diff && from !== null && to !== null ? `Changes from version ${Math.min(from, to)} to ${Math.max(from, to)}` : 'Detail'}
            </h2>
            {view && (
              <>
                <p className="muted small">
                  {view.label ?? 'autosave'} · {fmtWhen(view.updatedAt)} · {view.updatedBy}
                </p>
                <div className="note-readonly note-html" tabIndex={0} role="region" aria-label="Note text" dangerouslySetInnerHTML={{ __html: docToHtml(view.doc, { mode: view.mode, stripComments: true }) }} />
              </>
            )}
            {diff && (
              <>
                <p className="muted small">{diff.summary}</p>
                {diff.tables.length > 0 && (
                  <table className="cell-diff" aria-label="Changed table cells">
                    <thead>
                      <tr>
                        <th scope="col">Table</th>
                        <th scope="col">Row</th>
                        <th scope="col">Column</th>
                        <th scope="col">Old</th>
                        <th scope="col">New</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.tables.map((c, i) => (
                        <tr key={i}>
                          <td>{c.table}</td>
                          <td>{c.row}</td>
                          <td>{c.column}</td>
                          <td className="num">{c.old === null ? '—' : c.old.toLocaleString('en-US')}</td>
                          <td className="num">{c.new === null ? '—' : c.new.toLocaleString('en-US')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="muted small legend">
                  <ins>Inserted text</ins> is underlined; <del>deleted text</del> is struck through.
                </p>
                <div className="note-readonly note-html redline" tabIndex={0} role="region" aria-label="Note text" dangerouslySetInnerHTML={{ __html: diff.html }} />
              </>
            )}
            {!view && !diff && <p className="muted">Choose View or Compare on a version.</p>}
          </section>
        </div>
        <p>
          <button type="button" className="secondary" onClick={() => navigate(`/notes/${revisionId}`)}>
            Back to the note
          </button>
        </p>
      </div>
    </RequireRole>
  );
}
