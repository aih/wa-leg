import { Fragment } from 'react';
import { Link, useNavigate } from 'react-router';
import { STATE_HINTS, STATE_LABELS, WORKFLOW_STATES, type WorkflowState } from '@wa-leg/workflow-machine';
import type { NoteRow } from '../lib/listApi';
import { fmtWhen } from './api';

/** One table of notes grouped by status in path order: Draft, In review, Changes requested, Approved, Published. */
export function NotesList({ notes, empty = 'No notes.' }: { notes: NoteRow[]; empty?: string }) {
  const navigate = useNavigate();
  if (notes.length === 0) return <p className="muted">{empty}</p>;
  const groups = WORKFLOW_STATES.map((state) => ({ state, rows: notes.filter((n) => n.state === state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) })).filter((g) => g.rows.length > 0);
  const other = notes.filter((n) => !WORKFLOW_STATES.includes(n.state));
  const open = (id: string) => navigate(`/notes/${id}`);
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Notes, scrolls horizontally on narrow screens">
      <table className="notes-table">
        <thead>
          <tr>
            <th scope="col">Bill</th>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Drafter</th>
            <th scope="col">Reviewer</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <Fragment key={g.state}>
            <tbody>
              <tr className="group-row">
                <th scope="rowgroup" colSpan={6}>
                  {STATE_LABELS[g.state]} <span className="muted small">({g.rows.length})</span>
                </th>
              </tr>
              {g.rows.map((n) => (
                <Row key={n.noteRevisionId} n={n} state={g.state} onOpen={open} />
              ))}
            </tbody>
          </Fragment>
        ))}
        {other.length > 0 && (
          <tbody>
            {other.map((n) => (
              <Row key={n.noteRevisionId} n={n} state={null} onOpen={open} />
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
}

function Row({ n, state, onOpen }: { n: NoteRow; state: WorkflowState | null; onOpen: (id: string) => void }) {
  return (
    <tr
      className="note-row"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onOpen(n.noteRevisionId);
      }}
    >
      <td>
        <Link to={`/notes/${n.noteRevisionId}`}>{n.versionLabel}</Link>
      </td>
      <td>{n.billTitle ?? <span className="muted">—</span>}</td>
      <td>
        <span className={`status status-${n.state}`} title={state ? STATE_HINTS[state] : undefined}>
          {state ? STATE_LABELS[state] : n.state}
        </span>
      </td>
      <td>{n.drafter?.displayName ?? n.drafter?.userId ?? <span className="muted">—</span>}</td>
      <td>{n.reviewer?.displayName ?? n.reviewer?.userId ?? <span className="muted">—</span>}</td>
      <td>{fmtWhen(n.updatedAt)}</td>
    </tr>
  );
}
