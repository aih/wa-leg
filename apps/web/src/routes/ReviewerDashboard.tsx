import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { NoteList } from '../notes/NoteList';
import { notesApi, useResource } from '../notes/api';

/** Reviewer dashboard in the reviewer vocabulary. Claiming, deadlines and hearing ordering arrive with milestone 6. */
export function ReviewerDashboard() {
  const { principal } = useSession();
  const notes = useResource(principal ? () => notesApi.list() : null, [principal?.userId]);
  const all = notes.data ?? [];
  return (
    <RequireRole roles={['reviewer', 'approver', 'manager']}>
      <h1>Review dashboard</h1>
      {notes.error && <p role="alert">{notes.error.message}</p>}
      <section aria-labelledby="queue">
        <h2 id="queue">Pending my review</h2>
        <NoteList notes={all.filter((n) => n.state === 'review.pending' || n.state === 'exec_review.pending')} vocabulary="reviewer" empty="Nothing is waiting for review." />
      </section>
      <section aria-labelledby="active">
        <h2 id="active">In review</h2>
        <NoteList notes={all.filter((n) => n.state === 'review.active' || n.state === 'exec_review.active')} vocabulary="reviewer" empty="Nothing is being reviewed." />
      </section>
      <section aria-labelledby="drafting">
        <h2 id="drafting">Being drafted</h2>
        <NoteList notes={all.filter((n) => ['todo', 'in_progress', 'changes_requested'].includes(n.state))} vocabulary="reviewer" empty="Nothing is being drafted." />
      </section>
      <section aria-labelledby="done">
        <h2 id="done">Approved</h2>
        <NoteList notes={all.filter((n) => n.state === 'approved')} vocabulary="reviewer" empty="No approved notes yet." />
      </section>
      <p className="muted">To start a note, open a bill and use “New fiscal note” beside the text.</p>
    </RequireRole>
  );
}
