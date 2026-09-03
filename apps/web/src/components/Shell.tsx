import { Link, NavLink, Outlet } from 'react-router';
import { useSession } from '../lib/session';
import { loginUrl } from '../lib/api';
import { SearchBox } from './SearchBox';
import { useEffect, useState } from 'react';
import { notificationsApi } from '../notes/api';

export function Shell() {
  const { principal, loading, hasRole, logout } = useSession();
  const unread = useUnreadCount(!!principal);
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
          {principal && (
            <NavLink to="/inbox">
              Inbox{unread > 0 && <span className="badge-count" aria-label={`${unread} unread`}> {unread}</span>}
            </NavLink>
          )}
          {hasRole('template_editor', 'admin') && <NavLink to="/admin/templates">Templates</NavLink>}
          {hasRole('admin') && <NavLink to="/admin/ingest">Ingest</NavLink>}
          {hasRole('admin', 'manager') && <NavLink to="/admin/audit">Audit</NavLink>}
          <NavLink to="/guide">Guide</NavLink>
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

/** Unread notification count, refreshed every minute and when the tab regains focus. */
function useUnreadCount(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const load = () => notificationsApi.unreadCount().then((r) => !stopped && setN(r.unread)).catch(() => undefined);
    load();
    const h = window.setInterval(load, 60_000);
    window.addEventListener('focus', load);
    window.addEventListener('notifications:changed', load);
    return () => {
      stopped = true;
      window.clearInterval(h);
      window.removeEventListener('focus', load);
      window.removeEventListener('notifications:changed', load);
    };
  }, [enabled]);
  return n;
}
