import { Navigate } from 'react-router';
import { useSession } from '../lib/session';
import { loginUrl } from '../lib/api';

export function Home() {
  const { principal, loading, hasRole } = useSession();
  if (loading) return <p aria-live="polite">Loading…</p>;
  if (!principal) {
    return (
      <section className="hero">
        <h1>Fiscal Note Workbench</h1>
        <p>Read a bill, draft the Department of Revenue fiscal note against a specific version, review it, and publish it.</p>
        <p>
          <a className="button" href={loginUrl('/')}>
            Sign in
          </a>
        </p>
      </section>
    );
  }
  if (hasRole('drafter')) return <Navigate to="/dashboard/drafter" replace />;
  if (hasRole('reviewer', 'approver', 'manager')) return <Navigate to="/dashboard/reviewer" replace />;
  return (
    <section className="hero">
      <h1>Welcome, {principal.displayName}</h1>
      <p>Use the search box to find a bill. Approved fiscal notes appear beside the bill text.</p>
    </section>
  );
}
