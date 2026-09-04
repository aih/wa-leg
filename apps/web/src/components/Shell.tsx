import { Link, NavLink, Outlet } from 'react-router';
import { useSession } from '../lib/session';
import { loginUrl } from '../lib/api';
import { SearchBox } from './SearchBox';
import { APP_VERSION, COMMIT_URL, GIT_SHA, RELEASE_URL } from '../lib/version';
import { useTheme } from '../lib/theme';

export function Shell() {
  const { principal, loading, hasRole, logout } = useSession();
  const { theme, toggle } = useTheme();
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          <img src="/logo.svg" alt="WA$ Fiscal Note Workbench" height="32" />
        </Link>
        <SearchBox />
        <nav aria-label="Primary" className="nav">
          {hasRole('drafter', 'reviewer') && <NavLink to="/notes">Notes</NavLink>}
          {principal && <NavLink to="/published">Published</NavLink>}
          <NavLink to="/guide">Guide</NavLink>
        </nav>
        <div className="session">
          <button type="button" className="linkish" aria-pressed={theme === 'dark'} onClick={toggle}>
            Dark mode
          </button>
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
      <footer className="footer">
        <span>Fiscal Note Workbench</span>
        <a href={RELEASE_URL} target="_blank" rel="noreferrer">
          v{APP_VERSION}
        </a>
        <a href={COMMIT_URL} target="_blank" rel="noreferrer" title="Commit">
          <code>{GIT_SHA}</code>
        </a>
      </footer>
    </div>
  );
}
