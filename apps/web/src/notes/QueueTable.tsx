import { Link } from 'react-router';
import { drafterStatus, reviewerStatus, type WorkflowState } from '@wa-leg/workflow-machine';
import { BAND_LABELS, DRAFTER_LABELS, REVIEWER_LABELS, dueCountdown, fmtWhen, type AssignmentRow } from './api';

export interface QueueTableProps {
  rows: AssignmentRow[];
  vocabulary: 'drafter' | 'reviewer';
  empty: string;
  /** Extra cell per row (assigner controls). */
  extra?: (row: AssignmentRow) => React.ReactNode;
  showAssignee?: boolean;
}

/** Work queue: bill, version, title, status in the role vocabulary, due (band as text), hearing, counterpart, last activity. */
export function QueueTable({ rows, vocabulary, empty, extra, showAssignee }: QueueTableProps) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  // Labels come from the state in the viewer's vocabulary, whichever role the row was fetched for.
  const labelOf = (state: string) => (vocabulary === 'drafter' ? DRAFTER_LABELS[drafterStatus(state as WorkflowState)] : REVIEWER_LABELS[reviewerStatus(state as WorkflowState)]) ?? state;
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Table, scrolls horizontally on narrow screens">
      <table className="queue">
        <thead>
          <tr>
            <th scope="col">Bill</th>
            <th scope="col">Status</th>
            <th scope="col">Due</th>
            <th scope="col">Hearing</th>
            <th scope="col">{showAssignee ? 'Drafter' : vocabulary === 'drafter' ? 'Reviewer' : 'Drafter'}</th>
            <th scope="col">Updated</th>
            {extra && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.instanceId}-${r.role}-${r.position}`} className={`band-${r.band}`}>
              <td>
                <Link to={`/notes/${r.noteRevisionId}`}>{r.versionLabel}</Link>
                {r.kind === 'estimate' && <span className="muted"> (estimate)</span>}
                {r.confidential && <span className="chip">Confidential</span>}
                {r.priority !== 'normal' && <span className="chip">{r.priority}</span>}
                {r.title && <div className="muted small">{r.title}</div>}
              </td>
              <td>
                <span className={`status status-${r.state.replace('.', '-')}`}>{labelOf(r.state)}</span>
                {r.pool && <div className="muted small">unclaimed</div>}
                {r.role === 'exec' && <div className="muted small">executive step {r.position + 1}</div>}
                {r.supersededBy && <div className="muted small">superseded</div>}
              </td>
              <td>
                {r.effectiveDueAt ? (
                  <>
                    <span className={`band-label band-${r.band}`}>{BAND_LABELS[r.band]}</span>
                    <div className="small" title={fmtWhen(r.effectiveDueAt)}>
                      {dueCountdown(r.effectiveDueAt)}
                    </div>
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>{r.nextHearingAt ? fmtWhen(r.nextHearingAt) : <span className="muted">none</span>}</td>
              <td>{r.counterpart?.displayName ?? r.counterpart?.userId ?? <span className="muted">—</span>}</td>
              <td>{fmtWhen(r.updatedAt)}</td>
              {extra && <td>{extra(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
