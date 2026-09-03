import { useState } from 'react';
import { RequireRole } from '../components/RequireRole';
import { api, ApiError } from '../lib/api';
import { fmtWhen, useResource } from '../notes/api';
import '../notes/notes.css';

interface IngestRun {
  id: string;
  source: string;
  path: string | null;
  status: string;
  requestedBy: string;
  startedAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

/** Ingest runs and a refresh trigger (admin). */
export function AdminIngest() {
  const runs = useResource(() => api<IngestRun[]>('/admin/ingest/runs'), []);
  const [bills, setBills] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (source: 'refresh' | 'legiscan') => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const keys = bills
        .split(/[,\s]+/)
        .map((b) => b.trim().toUpperCase())
        .filter(Boolean)
        .map((b) => (b.includes(':') ? b : `WA:2025-26:${b}`));
      const res = await api<{ job_id: string }>('/admin/ingest/runs', { method: 'POST', body: { source, billKeys: keys.length ? keys : undefined } });
      setMessage(`Started ${source} run ${res.job_id.slice(0, 8)}…`);
      window.setTimeout(() => void runs.reload(), 1500);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RequireRole roles={['admin']}>
      <h1>Ingest</h1>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void start('refresh');
        }}
        aria-label="Start a run"
      >
        <div className="field">
          <label htmlFor="ing-bills">Bills (optional, comma-separated, e.g. HB2402, SB6137)</label>
          <input id="ing-bills" value={bills} onChange={(e) => setBills(e.target.value)} />
        </div>
        <button type="submit" disabled={busy}>
          Refresh documents from lawfilesext
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void start('legiscan')}>
          Reload from the Legiscan dataset
        </button>
        <button type="button" className="linkish" onClick={() => void runs.reload()}>
          Reload list
        </button>
      </form>
      {message && (
        <p role="status" className="ok">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {runs.error && <p role="alert">{runs.error.message}</p>}
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Table, scrolls horizontally on narrow screens">
        <table>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">By</th>
              <th scope="col">Finished</th>
              <th scope="col">Stats</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{fmtWhen(r.startedAt)}</td>
                <td>
                  {r.source}
                  {r.path && <div className="muted small">{r.path}</div>}
                </td>
                <td>
                  <span className={`status status-${r.status}`}>{r.status}</span>
                  {r.error && <div className="error small">{r.error}</div>}
                </td>
                <td>{r.requestedBy}</td>
                <td>{r.finishedAt ? fmtWhen(r.finishedAt) : <span className="muted">running</span>}</td>
                <td className="small">{r.stats ? JSON.stringify(r.stats) : ''}</td>
              </tr>
            ))}
            {runs.data && runs.data.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No runs yet. Use the CLI (`pnpm wa-leg ingest legiscan …`) or start a refresh above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </RequireRole>
  );
}
