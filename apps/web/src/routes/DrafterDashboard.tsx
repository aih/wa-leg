import { RequireRole } from '../components/RequireRole';
import { useSession } from '../lib/session';
import { QueueTable } from '../notes/QueueTable';
import { notificationsApi, useResource, workflowApi } from '../notes/api';
import { fmtWhen } from '../notes/api';
import { Link } from 'react-router';
import '../notes/notes.css';

const ACTION = new Set(['to-do', 'in-progress', 'address-review']);
const WAITING = new Set(['ready-for-review']);
const DAYS_14 = 14 * 86_400_000;

/** Drafter dashboard from GET /assignments, in the drafter vocabulary, sorted by effective due. */
export function DrafterDashboard() {
  const { principal, hasRole } = useSession();
  const mine = useResource(principal ? () => workflowApi.assignments({ role: 'drafter' }) : null, [principal?.userId]);
  const reviews = useResource(principal && hasRole('reviewer', 'approver') ? () => workflowApi.assignments({ role: 'reviewer' }) : null, [principal?.userId]);
  const execs = useResource(principal && hasRole('approver') ? () => workflowApi.assignments({ role: 'exec' }) : null, [principal?.userId]);
  const alerts = useResource(principal ? () => notificationsApi.list(false) : null, [principal?.userId]);
  const rows = mine.data ?? [];
  const recent = rows.filter((r) => r.status === 'approved' && Date.now() - new Date(r.updatedAt).getTime() < DAYS_14);
  const billAlerts = (alerts.data ?? []).filter((n) => n.type.startsWith('bill.') || n.type.startsWith('hearing.') || n.type === 'note.superseded').slice(0, 20);
  return (
    <RequireRole roles={['drafter']}>
      <div className="dash-head">
        <h1>Drafter dashboard</h1>
        <div className="counts" aria-label="Counts">
          <span>{rows.filter((r) => ACTION.has(r.status)).length} needing action</span>
          <span>{rows.filter((r) => WAITING.has(r.status)).length} waiting on others</span>
          <span>{rows.filter((r) => r.band === 'overdue').length} overdue</span>
        </div>
      </div>
      {mine.error && <p role="alert">{mine.error.message}</p>}
      <section aria-labelledby="need-action">
        <h2 id="need-action">My notes needing action</h2>
        <QueueTable rows={rows.filter((r) => ACTION.has(r.status))} vocabulary="drafter" empty="Nothing needs your action." />
      </section>
      <section aria-labelledby="waiting">
        <h2 id="waiting">My notes waiting on others</h2>
        <QueueTable rows={rows.filter((r) => WAITING.has(r.status))} vocabulary="drafter" empty="Nothing is waiting on a reviewer." />
      </section>
      {(reviews.data || execs.data) && (
        <section aria-labelledby="my-reviews">
          <h2 id="my-reviews">My review assignments</h2>
          <QueueTable rows={[...(reviews.data ?? []), ...(execs.data ?? [])]} vocabulary="reviewer" empty="No reviews assigned to you." />
        </section>
      )}
      <section aria-labelledby="approved">
        <h2 id="approved">Recently approved</h2>
        <QueueTable rows={recent} vocabulary="drafter" empty="No approvals in the last 14 days." />
      </section>
      <section aria-labelledby="alerts">
        <h2 id="alerts">Bill change alerts</h2>
        {billAlerts.length === 0 ? (
          <p className="muted">No bill changes affect your notes.</p>
        ) : (
          <ul className="plain">
            {billAlerts.map((n) => (
              <li key={n.id}>
                {n.link ? <Link to={n.link}>{n.title}</Link> : n.title} <span className="muted small">{fmtWhen(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </RequireRole>
  );
}
