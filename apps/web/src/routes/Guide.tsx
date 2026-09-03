import { useEffect } from 'react';
import { Link } from 'react-router';
import { STATE_HINTS, STATE_LABELS, WORKFLOW_STATES } from '@wa-leg/workflow-machine';
import { loginUrl } from '../lib/api';
import { DEMO_NOTES, TEST_USERS } from '../lib/demo';

const billHref = (n: (typeof DEMO_NOTES)[number]) => `/bills/${n.biennium}/${n.billId}/${n.versionCode}`;

/** The walkthrough: one section per stage of the path, with the test users and the seeded notes. */
export function Guide() {
  useEffect(() => {
    document.title = 'Guide · Fiscal Note Workbench';
  }, []);
  const note = (billId: string) => DEMO_NOTES.find((n) => n.billId === billId)!;
  const hb1004 = note('HB1004');
  const hb2081 = note('HB2081');
  const sb5814 = note('SB5814');
  const hb1019 = note('HB1019');
  const hb2402 = note('HB2402');
  return (
    <article className="guide">
      <h1>Guide</h1>
      <p>
        A fiscal note goes from draft to the Committee along one path: create, draft, submit, review, resolve, approve, publish. This page walks the path
        with the four test users and the five seeded notes.
      </p>
      <nav aria-label="On this page" className="guide-toc">
        <a href="#users">Test users</a> · <a href="#seed">Seeded notes</a> · <a href="#create">Create</a> · <a href="#draft">Draft</a> · <a href="#submit">Submit</a> ·{' '}
        <a href="#review">Review and request changes</a> · <a href="#resolve">Resolve and resubmit</a> · <a href="#approve">Approve</a> · <a href="#publish">Publish</a> ·{' '}
        <a href="#committee">Read as the Committee</a> · <a href="#statuses">Statuses</a>
      </nav>

      <h2 id="users">Test users</h2>
      <p>
        Sign-in goes through a development identity provider that lists these users. Pick one from the list, or open{' '}
        <code>/api/v1/auth/login?login_hint=dev-drafter</code> to skip the picker.
      </p>
      <table className="guide-table">
        <thead>
          <tr>
            <th scope="col">User</th>
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

      <h2 id="seed">Seeded notes</h2>
      <p>
        <code>pnpm wa-leg demo seed --reset</code> creates five notes on five bills, one in each status:
      </p>
      <table className="guide-table">
        <thead>
          <tr>
            <th scope="col">Bill</th>
            <th scope="col">Drafter</th>
            <th scope="col">Status</th>
            <th scope="col">Shows</th>
          </tr>
        </thead>
        <tbody>
          {DEMO_NOTES.map((n) => (
            <tr key={n.billId}>
              <td>
                <Link to={billHref(n)}>{n.bill}</Link>
                <div className="muted small">{n.title}</div>
              </td>
              <td>{n.drafter}</td>
              <td>{STATE_LABELS[n.state]}</td>
              <td>{n.shows}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        The seed needs the bills HB 1004, HB 1019, HB 2081, HB 2402 and SB 5814 loaded by <code>pnpm wa-leg ingest</code>; it skips any that are missing.
      </p>

      <h2 id="create">1. Create (Rae Reviewer)</h2>
      <ol>
        <li>
          Sign in as Rae. <Link to="/notes">Notes</Link> lists every note grouped by status.
        </li>
        <li>
          Search <code>hb 1483</code> and open the bill. In the right pane, <strong>New fiscal note</strong> asks for the bill version, a template and the
          drafter. Choose Dana. <strong>Create and open</strong> lands in the workspace with the note in <em>Draft</em>.
        </li>
        <li>A drafter can also create a note on a bill; the form has no drafter field and the note is theirs.</li>
      </ol>

      <h2 id="draft">2. Draft (Dana Drafter)</h2>
      <ol>
        <li>
          Sign in as Dana. <Link to="/notes">Notes</Link> lists {hb1004.bill}, {hb2081.bill}, {sb5814.bill} and {hb2402.bill}. Open {hb1004.bill} ({STATE_LABELS[hb1004.state]}).
        </li>
        <li>
          The bill is on the left, the note on the right. Unfilled slots carry a dashed outline and a hint; <kbd>Tab</kbd> moves to the next one. Type{' '}
          <code>-4310000</code> into a cash receipts cell: totals recompute and the cell formats as <code>(4,310,000)</code>.
        </li>
        <li>
          <strong>Cite</strong> in the bill pane inserts a citation at the caret. A second <strong>Cite</strong> on the same section selects the existing
          citation and shows <em>Already cited</em>. The <code>×</code> on a citation removes it.
        </li>
        <li>
          Select a sentence and press <strong>Comment</strong> to start a thread on it. The <em>Comments</em> tab lists the threads.
        </li>
        <li>The note saves itself as you type.</li>
      </ol>

      <h2 id="submit">3. Submit (Dana Drafter)</h2>
      <ol>
        <li>
          <strong>Submit for review</strong> in the workflow bar; the message is optional. Status: <em>{STATE_LABELS.in_review}</em>.
        </li>
        <li>The editor is read-only until a reviewer acts. {hb2081.bill} is seeded in this status.</li>
      </ol>

      <h2 id="review">4. Review and request changes (Rae Reviewer)</h2>
      <ol>
        <li>
          Sign in as Rae and open {hb2081.bill} from <Link to="/notes">Notes</Link>. The drafter and the status are in the workflow bar.
        </li>
        <li>Comment on two sentences.</li>
        <li>
          <strong>Request changes</strong> and write a message; the message is required. The dialog has one <strong>Cancel</strong> button. Status:{' '}
          <em>{STATE_LABELS.changes_requested}</em>. Rae is now the note's reviewer.
        </li>
        <li>{sb5814.bill} is seeded in this status with Rae's message and two open threads.</li>
      </ol>

      <h2 id="resolve">5. Resolve and resubmit (Dana Drafter)</h2>
      <ol>
        <li>
          Sign in as Dana and open {sb5814.bill}. A banner shows who requested changes, when, the message, and <em>2 open comment threads</em> with a
          link to the Comments tab.
        </li>
        <li>Resolve both threads, edit the note, then <strong>Submit for review</strong> with a reply.</li>
        <li>
          Status: <em>{STATE_LABELS.in_review}</em>. <strong>History</strong> lists the request and the reply.
        </li>
      </ol>

      <h2 id="approve">6. Approve (Rae Reviewer)</h2>
      <ol>
        <li>
          Sign in as Rae and open the note. <strong>Approve</strong>. Status: <em>{STATE_LABELS.approved}</em>; the document is frozen at the approved
          version.
        </li>
        <li>
          <strong>Export</strong> in the workflow bar produces PDF, DOCX, HTML and XML of the approved version. {hb1019.bill} is seeded in this status
          after one round of changes.
        </li>
      </ol>

      <h2 id="publish">7. Publish (Rae Reviewer)</h2>
      <ol>
        <li>
          <strong>Publish</strong>. Status: <em>{STATE_LABELS.published}</em>. A published note never changes; a correction is a new note on the same bill
          version.
        </li>
        <li>
          <Link to="/published">Published</Link> lists it newest first with the four export links. {hb2402.bill} is seeded in this status.
        </li>
      </ol>

      <h2 id="committee">8. Read as the Committee (Cam Committee)</h2>
      <ol>
        <li>
          Sign in as Cam. The landing page goes to <Link to="/published">Published</Link>: bill, version, title, published date, and PDF, DOCX, HTML and XML
          links for each note.
        </li>
        <li>
          Open <Link to={billHref(hb2402)}>{hb2402.bill}</Link>. The <strong>Fiscal note</strong> panel shows the published note beside the bill text with
          the same links. Switch the version to HB 2402: the panel says it is showing the note for a later version.
        </li>
        <li>
          Cam cannot open notes that are not published. <code>GET /api/v1/published</code> returns the same list for a downstream system.
        </li>
      </ol>

      <h2 id="statuses">Statuses</h2>
      <table className="guide-table">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Meaning</th>
            <th scope="col">Who acts</th>
          </tr>
        </thead>
        <tbody>
          {WORKFLOW_STATES.map((s) => (
            <tr key={s}>
              <td>{STATE_LABELS[s]}</td>
              <td>{STATE_HINTS[s]}</td>
              <td>{WHO_ACTS[s]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
}

const WHO_ACTS: Record<(typeof WORKFLOW_STATES)[number], string> = {
  draft: 'Drafter: Submit for review',
  in_review: 'Reviewer: Request changes or Approve',
  changes_requested: 'Drafter: Submit for review',
  approved: 'Reviewer: Publish',
  published: 'Nobody',
};
