import { Link } from 'react-router';
import { fmtWhen, STATE_LABELS, type NoteSummary } from './api';

/** Compact table of note revisions with links into the workspace. */
export function NoteList({ notes, empty = 'No notes.', showBill = true }: { notes: NoteSummary[]; empty?: string; showBill?: boolean }) {
  if (notes.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="note-list">
      <thead>
        <tr>
          {showBill && <th scope="col">Bill</th>}
          <th scope="col">Note</th>
          <th scope="col">Status</th>
          <th scope="col">Drafter</th>
          <th scope="col">Reviewer</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {notes.map((n) => (
          <tr key={n.noteRevisionId}>
            {showBill && (
              <td>
                <Link to={`/notes/${n.noteRevisionId}`}>{n.versionLabel}</Link>
                {n.billTitle && <div className="muted small">{n.billTitle}</div>}
              </td>
            )}
            <td>{showBill ? 'fiscal note' : <Link to={`/notes/${n.noteRevisionId}`}>{n.versionLabel} fiscal note</Link>}</td>
            <td>
              <span className={`status status-${n.state}`}>{STATE_LABELS[n.state] ?? n.state}</span>
            </td>
            <td>{n.drafter?.displayName ?? n.drafter?.userId ?? '—'}</td>
            <td>{n.reviewer?.displayName ?? n.reviewer?.userId ?? '—'}</td>
            <td>{fmtWhen(n.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
