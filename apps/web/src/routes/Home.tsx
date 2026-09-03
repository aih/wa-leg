import { Link, Navigate } from 'react-router';
import { useSession } from '../lib/session';
import { loginUrl } from '../lib/api';
import { TEST_USERS } from './Guide';

/** Landing page: what the workbench is for, who uses it, and how to try it. Signed-in drafters and reviewers go to their dashboard. */
export function Home() {
  const { principal, loading, hasRole } = useSession();
  if (loading) return <p aria-live="polite">Loading…</p>;
  if (principal && hasRole('drafter')) return <Navigate to="/dashboard/drafter" replace />;
  if (principal && hasRole('reviewer', 'approver', 'manager')) return <Navigate to="/dashboard/reviewer" replace />;
  return (
    <div className="landing">
      <section className="hero">
        <h1>{principal ? `Welcome, ${principal.displayName}` : 'Fiscal Note Workbench'}</h1>
        <p className="lede">
          A drafting and review tool for the Department of Revenue’s fiscal notes: read the bill, write the note against one version of it, review and
          approve it on the 72-hour clock, and publish it beside the bill text.
        </p>
        <p className="row">
          {principal ? (
            <span className="muted">Use the search box to find a bill. Approved fiscal notes appear beside the bill text.</span>
          ) : (
            <a className="button" href={loginUrl('/')}>
              Sign in
            </a>
          )}
          <Link className="button secondary" to="/guide">
            Read the walkthrough
          </Link>
        </p>
      </section>

      <section aria-labelledby="what-h" className="landing-cols">
        <div>
          <h2 id="what-h">What it does</h2>
          <ul>
            <li>
              <strong>Bill viewer.</strong> Every bill of the biennium with its versions and amendments, an outline that names each section, the RCW
              sections affected, and a redline between any two versions.
            </li>
            <li>
              <strong>Note editor.</strong> Templates for the common cases, estimate tables that add themselves up, citations into the bill, formulas,
              comments and a version history with a redline.
            </li>
            <li>
              <strong>Review workflow.</strong> One status per note from <em>To do</em> to <em>Approved</em>; itemised change requests the drafter
              closes one by one; an executive review chain; three deadlines with an inbox and email.
            </li>
            <li>
              <strong>Publishing.</strong> The approved note appears beside the bill for every reader and exports to PDF, DOCX and HTML.
            </li>
          </ul>
        </div>
        <div>
          <h2 id="who-h">Who uses it</h2>
          <dl className="personas">
            <dt>Drafters</dt>
            <dd>Write the note against a bill version, answer comments, address change requests, resubmit.</dd>
            <dt>Reviewers and assigners</dt>
            <dd>Create the request from a bill, assign it, claim the review, request changes or approve, set the executive chain.</dd>
            <dt>Executive reviewers</dt>
            <dd>Complete or return their step of the chain before the note is published.</dd>
            <dt>Readers</dt>
            <dd>Find a bill and read the approved note beside its text, on a desktop or a phone.</dd>
            <dt>Managers and admins</dt>
            <dd>Watch the team queue and deadlines, reassign or cancel, run ingests, read the audit log, edit templates.</dd>
          </dl>
        </div>
      </section>

      <section aria-labelledby="try-h">
        <h2 id="try-h">How to try it</h2>
        <p>
          Sign in as one of the test users below. The seeded data holds ten notes on ten different bills, one in each workflow state, so every
          dashboard has rows and every button has something to act on. The <Link to="/guide">guide</Link> walks through each persona in order and lists
          what to check.
        </p>
        <table className="guide-table">
          <thead>
            <tr>
              <th scope="col">Sign in as</th>
              <th scope="col">Roles</th>
              <th scope="col">Start with</th>
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
        <ol className="try-steps">
          <li>
            <strong>Rae Reviewer</strong>: the Review dashboard, the team queue, and <em>New fiscal note</em> on any bill.
          </li>
          <li>
            <strong>Dana Drafter</strong>: the Drafting dashboard, the ESSB 5814 change request in the Changes tab, the editor on HB 1004.
          </li>
          <li>
            <strong>Avery Approver</strong> and <strong>Blake Budget</strong>: the executive review steps on HB 1047.
          </li>
          <li>
            <strong>Val Viewer</strong>: search <code>shb 2402</code> and read the approved note beside the bill.
          </li>
        </ol>
      </section>
    </div>
  );
}
