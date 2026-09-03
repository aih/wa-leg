import { Link, NavLink, Outlet } from 'react-router';
import { useSession } from '../lib/session';
import { loginUrl } from '../lib/api';
import { SearchBox } from './SearchBox';

export function Shell() {
  const { principal, loading, hasRole, logout } = useSession();
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          Fiscal Note Workbench
        </Link>
        <SearchBox />
        <nav aria-label="Primary" className="nav">
          {hasRole('drafter') && <NavLink to="/dashboard/drafter">Drafting</NavLink>}
          {hasRole('reviewer', 'approver', 'manager') && <NavLink to="/dashboard/reviewer">Review</NavLink>}
          {principal && <NavLink to="/inbox">Inbox</NavLink>}
          {hasRole('template_editor', 'admin') && <NavLink to="/admin/templates">Templates</NavLink>}
          {hasRole('admin') && <NavLink to="/admin/ingest">Ingest</NavLink>}
        </nav>
        <div className="session">
          {loading ? (
            <span aria-live="polite">Loading…</span>
          ) : principal ? (
            <>
              <span className="who" title={principal.roles.join(', ')}>
                {principal.displayName}
              </span>
              <button type="button" className="linkish" onClick={() => void logout()}>
                Sign out
              </button>
            </>
          ) : (
            <a href={loginUrl()}>Sign in</a>
          )}
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
