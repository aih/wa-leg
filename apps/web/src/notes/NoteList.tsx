import { Link } from 'react-router';
import { fmtWhen, STATE_LABELS, type NoteSummary } from './api';

/** Compact table of note revisions with links into the workspace. */
export function NoteList({ notes, empty = 'No notes.', showBill = true, vocabulary = 'drafter' }: { notes: NoteSummary[]; empty?: string; showBill?: boolean; vocabulary?: 'drafter' | 'reviewer' }) {
  if (notes.length === 0) return <p className="muted">{empty}</p>;
  return (
    <table className="note-list">
      <thead>
        <tr>
          {showBill && <th scope="col">Bill</th>}
          <th scope="col">Kind</th>
          <th scope="col">Status</th>
          <th scope="col">Drafter</th>
          <th scope="col">Due</th>
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
            <td>{showBill ? n.kind : <Link to={`/notes/${n.noteRevisionId}`}>{n.versionLabel} {n.kind}</Link>}</td>
            <td>
              <span className={`status status-${n.state.replace('.', '-')}`}>{vocabulary === 'reviewer' ? n.reviewerStatus : n.drafterStatus}</span>
              <span className="visually-hidden"> ({STATE_LABELS[n.state] ?? n.state})</span>
            </td>
            <td>{n.drafter?.displayName ?? n.drafter?.userId ?? '—'}</td>
            <td>{n.effectiveDueAt ? fmtWhen(n.effectiveDueAt) : '—'}</td>
            <td>{fmtWhen(n.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
