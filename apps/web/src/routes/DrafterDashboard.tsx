import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { NoteList } from '../notes/NoteList';
import { notesApi, useResource } from '../notes/api';

const ACTION_STATES = new Set(['todo', 'in_progress', 'changes_requested']);
const WAITING_STATES = new Set(['review.pending', 'review.active', 'exec_review.pending', 'exec_review.active']);

/** Drafter dashboard: the drafter's own notes grouped by what they need to do. Work queues from the
 *  workflow module (hearings, deadlines, alerts) arrive with milestone 6. */
export function DrafterDashboard() {
  const { principal } = useSession();
  const notes = useResource(principal ? () => notesApi.list({ assignee: principal.userId }) : null, [principal?.userId]);
  const mine = (notes.data ?? []).filter((n) => n.drafter?.userId === principal?.userId);
  return (
    <RequireRole roles={['drafter']}>
      <h1>Drafter dashboard</h1>
      {notes.error && <p role="alert">{notes.error.message}</p>}
      <section aria-labelledby="need-action">
        <h2 id="need-action">My notes needing action</h2>
        <NoteList notes={mine.filter((n) => ACTION_STATES.has(n.state))} empty="Nothing needs your action." />
      </section>
      <section aria-labelledby="waiting">
        <h2 id="waiting">My notes waiting on others</h2>
        <NoteList notes={mine.filter((n) => WAITING_STATES.has(n.state))} empty="Nothing is waiting on a reviewer." />
      </section>
      <section aria-labelledby="approved">
        <h2 id="approved">Recently approved</h2>
        <NoteList notes={mine.filter((n) => n.state === 'approved')} empty="No approved notes yet." />
      </section>
      <section aria-labelledby="alerts">
        <h2 id="alerts">Bill change alerts</h2>
        <NoteList notes={mine.filter((n) => n.state === 'superseded' || !!n.supersededBy)} empty="No bill changes affect your notes." />
      </section>
    </RequireRole>
  );
}
