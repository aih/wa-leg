import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { RequireRole } from '../components/RequireRole';
import { api } from '../lib/api';
import { fmtWhen, useResource } from '../notes/api';
import '../notes/notes.css';

interface AuditRow {
  id: number;
  actorId: string;
  action: string;
  objectType: string;
  objectId: string;
  before: unknown;
  after: unknown;
  requestId: string | null;
  at: string;
}

/** Admin audit log: every transition, save, export and permission denial, filterable by action, actor and object. */
export function AdminAudit() {
  const [filters, setFilters] = useState({ action: '', actor: '', objectId: '', objectType: '' });
  const [applied, setApplied] = useState(filters);
  const rows = useResource(() => api<AuditRow[]>('/admin/audit', { query: { action: applied.action || undefined, actor: applied.actor || undefined, objectId: applied.objectId || undefined, objectType: applied.objectType || undefined, limit: 200 } }), [applied]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(filters);
  };
  return (
    <RequireRole roles={['admin', 'reviewer', 'manager']}>
      <h1>Audit log</h1>
      <form className="row" onSubmit={submit} aria-label="Audit filters">
        <div className="field">
          <label htmlFor="af-action">Action</label>
          <input id="af-action" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="e.g. note.export" list="af-actions" />
          <datalist id="af-actions">
            {['note.create', 'note.document_save', 'note.export', 'note.publish', 'workflow.submit_for_review', 'workflow.approve', 'workflow.request_changes', 'permission.denied', 'ingest.run'].map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="af-actor">Actor</label>
          <input id="af-actor" value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} placeholder="user id" />
        </div>
        <div className="field">
          <label htmlFor="af-object">Object id</label>
          <input id="af-object" value={filters.objectId} onChange={(e) => setFilters({ ...filters, objectId: e.target.value })} placeholder="note revision id" />
        </div>
        <div className="field">
          <label htmlFor="af-type">Object type</label>
          <select id="af-type" value={filters.objectType} onChange={(e) => setFilters({ ...filters, objectType: e.target.value })}>
            <option value="">Any</option>
            <option value="note_revision">Note revision</option>
            <option value="note">Note</option>
            <option value="notification">Notification</option>
            <option value="ingest_run">Ingest run</option>
            <option value="template">Template</option>
          </select>
        </div>
        <button type="submit">Filter</button>
      </form>
      {rows.error && <p role="alert">{rows.error.message}</p>}
      <div className="table-scroll">
        <table className="audit">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Object</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(rows.data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{fmtWhen(r.at)}</td>
                <td>{r.actorId}</td>
                <td>
                  <code>{r.action}</code>
                </td>
                <td>
                  {r.objectType === 'note_revision' ? <Link to={`/notes/${r.objectId}`}>{r.objectId.slice(0, 8)}…</Link> : `${r.objectType} ${r.objectId.slice(0, 12)}`}
                </td>
                <td className="small">
                  {r.before !== null && r.before !== undefined && <span className="muted">from {JSON.stringify(r.before)} </span>}
                  {r.after !== null && r.after !== undefined && <span>{JSON.stringify(r.after)}</span>}
                </td>
              </tr>
            ))}
            {rows.data && rows.data.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No audit rows match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </RequireRole>
  );
}
