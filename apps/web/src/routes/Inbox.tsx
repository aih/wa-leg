import { RequireRole } from '../components/RequireRole';

export function Inbox() {
  return (
    <RequireRole roles={[]}>
      <h1>Inbox</h1>
      <p className="muted">Notifications arrive with the workflow milestone.</p>
    </RequireRole>
  );
}
