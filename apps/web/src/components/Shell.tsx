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
          <button
            type="button"
            className="theme-toggle"
            aria-pressed={theme === 'dark'}
            aria-label="Dark mode"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            onClick={toggle}
          >
            <SunIcon />
            <MoonIcon />
            <span className="theme-knob" aria-hidden="true" />
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

function SunIcon() {
  return (
    <svg className="theme-icon sun" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M19.4 4.6l-2.1 2.1M6.7 17.3l-2.1 2.1" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="theme-icon moon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1z"
        fill="currentColor"
      />
    </svg>
  );
}
