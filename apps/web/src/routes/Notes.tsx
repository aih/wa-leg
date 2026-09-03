import { useEffect } from 'react';
import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { listNotes } from '../lib/listApi';
import { NotesList } from '../notes/NotesList';
import { useResource } from '../notes/api';
import '../notes/notes.css';

/** `/notes`: every note the signed-in drafter or reviewer can see, grouped by status. */
export function Notes() {
  const { principal, hasRole } = useSession();
  const notes = useResource(principal ? listNotes : null, [principal?.userId]);
  useEffect(() => {
    document.title = 'Notes · Fiscal Note Workbench';
  }, []);
  return (
    <RequireRole roles={['drafter', 'reviewer']}>
      <section className="notes-page" aria-labelledby="notes-h">
        <h1 id="notes-h">Notes</h1>
        <p className="muted">
          {hasRole('reviewer') ? 'Every note, grouped by status. A row opens the workspace.' : 'Your notes, grouped by status. A row opens the workspace.'}
          {' '}To start a note, open a bill and use <em>New fiscal note</em>.
        </p>
        {notes.error && <p role="alert">{notes.error.message}</p>}
        {notes.loading && !notes.data && (
          <p aria-live="polite" className="muted">
            Loading…
          </p>
        )}
        {notes.data && <NotesList notes={notes.data} empty="No notes yet." />}
      </section>
    </RequireRole>
  );
}
