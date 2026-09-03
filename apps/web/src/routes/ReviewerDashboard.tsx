import { useState } from 'react';
import { Link } from 'react-router';
import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { QueueTable } from '../notes/QueueTable';
import { fmtWhen, notesApi, useResource, workflowApi, STATE_LABELS, type AssignmentRow } from '../notes/api';
import '../notes/notes.css';

const STATE_ORDER = ['review.pending', 'review.active', 'exec_review.pending', 'exec_review.active', 'changes_requested', 'in_progress', 'todo', 'approved', 'cancelled', 'superseded'];

/** Reviewer dashboard: my pending reviews, changes requested, the team queue with assignment, unassigned hearings, approvals. */
export function ReviewerDashboard() {
  const { principal } = useSession();
  const mine = useResource(principal ? () => workflowApi.assignments({ role: 'reviewer' }) : null, [principal?.userId]);
  const execs = useResource(principal ? () => workflowApi.assignments({ role: 'exec' }) : null, [principal?.userId]);
  const team = useResource(principal ? () => workflowApi.assignments({ all: true, role: 'drafter' }) : null, [principal?.userId]);
  const hearings = useResource(principal ? () => workflowApi.unassignedHearings(72) : null, [principal?.userId]);
  const drafters = useResource(principal ? () => notesApi.users('drafter') : null, [principal?.userId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = [...(mine.data ?? []).filter((r) => r.state === 'review.pending' || r.state === 'review.active'), ...(execs.data ?? [])];
  const teamRows = team.data ?? [];
  const changes = teamRows.filter((r) => r.state === 'changes_requested');
  const approved = teamRows.filter((r) => r.state === 'approved');
  const grouped = new Map<string, AssignmentRow[]>();
  for (const r of teamRows) grouped.set(r.state, [...(grouped.get(r.state) ?? []), r]);

  const reassign = async (row: AssignmentRow, userId: string) => {
    if (!userId) return;
    setBusy(row.noteRevisionId);
    setError(null);
    try {
      await workflowApi.assign(row.noteRevisionId, { role: 'drafter', userId });
      await team.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const assignControl = (row: AssignmentRow) => (
    <span className="inline-assign">
      <label className="visually-hidden" htmlFor={`assign-${row.instanceId}`}>
        Assign drafter for {row.versionLabel}
      </label>
      <select id={`assign-${row.instanceId}`} defaultValue="" disabled={busy === row.noteRevisionId || ['approved', 'cancelled', 'superseded'].includes(row.state)} onChange={(e) => void reassign(row, e.target.value)}>
        <option value="">Reassign…</option>
        {(drafters.data ?? []).map((u) => (
          <option key={u.userId} value={u.userId}>
            {u.displayName}
          </option>
        ))}
      </select>
    </span>
  );

  return (
    <RequireRole roles={['reviewer', 'approver', 'manager']}>
      <div className="dash-head">
        <h1>Review dashboard</h1>
        <div className="counts" aria-label="Counts">
          <span>{pending.length} pending my review</span>
          <span>{changes.length} changes requested</span>
          <span>{teamRows.filter((r) => r.band === 'overdue').length} overdue</span>
        </div>
      </div>
      {(mine.error ?? team.error) && <p role="alert">{(mine.error ?? team.error)!.message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section aria-labelledby="pending">
        <h2 id="pending">Pending my review</h2>
        <QueueTable rows={pending} vocabulary="reviewer" empty="Nothing is waiting for your review." />
      </section>
      <section aria-labelledby="changes">
        <h2 id="changes">Changes requested, waiting on the drafter</h2>
        <QueueTable rows={changes} vocabulary="reviewer" showAssignee empty="No notes are back with a drafter." />
      </section>
      <section aria-labelledby="team">
        <h2 id="team">Team queue</h2>
        {teamRows.length === 0 && !team.loading && <p className="muted">No notes in scope. Open a bill and use “New fiscal note” to start one.</p>}
        {STATE_ORDER.filter((s) => grouped.has(s)).map((s) => (
          <details key={s} open={!['approved', 'cancelled', 'superseded'].includes(s)}>
            <summary>
              {STATE_LABELS[s] ?? s} ({grouped.get(s)!.length})
            </summary>
            <QueueTable rows={grouped.get(s)!} vocabulary="reviewer" showAssignee empty="" extra={assignControl} />
          </details>
        ))}
      </section>
      <section aria-labelledby="hearings">
        <h2 id="hearings">Unassigned bills with hearings within 72 hours</h2>
        {hearings.error && <p role="alert">{hearings.error.message}</p>}
        {(hearings.data ?? []).length === 0 ? (
          <p className="muted">Every bill with a hearing in the next 72 hours has a note.</p>
        ) : (
          <table className="queue">
            <thead>
              <tr>
                <th scope="col">Bill</th>
                <th scope="col">Hearing</th>
                <th scope="col">Committee</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {(hearings.data ?? []).map((h) => (
                <tr key={h.id}>
                  <td>
                    <Link to={`/bills/${h.biennium}/${h.billId}${h.versionCode ? `/${h.versionCode}` : ''}`}>{h.billId.replace(/^([A-Z]+)(\d+)$/, '$1 $2')}</Link>
                    <div className="muted small">{h.title}</div>
                  </td>
                  <td>{fmtWhen(h.hearingAt)}</td>
                  <td>
                    {h.committee} <span className="muted">({h.kind.replace('_', ' ')})</span>
                  </td>
                  <td>
                    <Link className="button secondary" to={`/bills/${h.biennium}/${h.billId}${h.versionCode ? `/${h.versionCode}` : ''}`}>
                      Create note
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="approved-h">
        <h2 id="approved-h">Approved this session</h2>
        <QueueTable rows={approved} vocabulary="reviewer" showAssignee empty="No approved notes yet." />
      </section>
    </RequireRole>
  );
}
