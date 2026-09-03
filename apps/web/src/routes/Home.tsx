import { useEffect } from 'react';
import { Link, Navigate } from 'react-router';
import { useSession } from '../lib/session';
import { loginUrl } from '../lib/api';
import { TEST_USERS } from '../lib/demo';

/** Landing page. Signed-in drafters and reviewers go to `/notes`; viewers go to `/published`. */
export function Home() {
  const { principal, loading, hasRole } = useSession();
  useEffect(() => {
    document.title = 'Fiscal Note Workbench';
  }, []);
  if (loading) return <p aria-live="polite">Loading…</p>;
  if (principal && hasRole('drafter', 'reviewer')) return <Navigate to="/notes" replace />;
  if (principal && hasRole('viewer')) return <Navigate to="/published" replace />;
  return (
    <div className="landing">
      <section className="hero">
        <h1>
          <img src="/logo.svg" alt="WA$ Fiscal Note Workbench" height="64" className="landing-logo" />
        </h1>
        <p className="lede">
          A fiscal note states what a bill does to state revenue and agency costs. The workbench keeps the bill text and the note side by side, takes the
          note from draft through review to publication, and gives the Committee every published note in PDF, DOCX, HTML and XML.
        </p>
        <p className="row">
          {principal ? (
            <span className="muted">Signed in as {principal.displayName}. Use the search box to find a bill.</span>
          ) : (
            <a className="button" href={loginUrl('/')}>
              Sign in
            </a>
          )}
          <Link className="button secondary" to="/guide">
            Read the guide
          </Link>
        </p>
      </section>

      <section aria-labelledby="path-h">
        <h2 id="path-h">The path</h2>
        <ol className="path-steps">
          <li>
            <strong>Draft.</strong> A reviewer creates the note on a bill version from a template and names the drafter, or a drafter creates one for
            themselves. The drafter writes against the bill text, cites sections, fills the estimate tables and submits.
          </li>
          <li>
            <strong>Review.</strong> The reviewer reads the note, comments on the text, and either requests changes with a message or approves. A change
            request goes back to the drafter with the open comment threads; the drafter resolves them and resubmits.
          </li>
          <li>
            <strong>Publish.</strong> Approval freezes the note. Publishing puts it beside the bill and on the Published page, where the Committee reads it
            and downloads it in four formats.
          </li>
        </ol>
      </section>

      <section aria-labelledby="try-h">
        <h2 id="try-h">Test users</h2>
        <p>
          Sign in as one of the four test users. The seeded data holds five notes on five bills, one in each status. The <Link to="/guide">guide</Link>{' '}
          walks the path from creation to the Committee with these users.
        </p>
        <table className="guide-table">
          <thead>
            <tr>
              <th scope="col">Sign in as</th>
              <th scope="col">Roles</th>
              <th scope="col">In the demo</th>
            </tr>
          </thead>
          <tbody>
            {TEST_USERS.map((u) => (
              <tr key={u.sub}>
                <td>
                  <a href={loginUrl('/', u.sub)}>{u.name}</a>
                </td>
                <td>{u.roles}</td>
                <td>{u.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
