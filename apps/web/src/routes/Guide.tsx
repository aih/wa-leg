import { useEffect } from 'react';
import { Link } from 'react-router';
import { loginUrl } from '../lib/api';

/** Test users the dev sign-in page offers, with the role each one demonstrates. */
export const TEST_USERS: { name: string; sub: string; roles: string; does: string }[] = [
  { name: 'Dana Drafter', sub: 'dev-drafter', roles: 'drafter', does: 'Writes notes; has one note in most states' },
  { name: 'Rae Reviewer', sub: 'dev-reviewer', roles: 'reviewer', does: 'Assigns work, reviews, requests changes, approves' },
  { name: 'Avery Approver', sub: 'dev-approver', roles: 'reviewer, approver', does: 'Reviews and sits first in the executive review chain' },
  { name: 'Blake Budget', sub: 'dev-exec-budget', roles: 'reviewer, approver (Budget)', does: 'Second step of the executive review chain' },
  { name: 'Jordan Both', sub: 'dev-both', roles: 'drafter, reviewer', does: 'Drafts some notes and reviews others' },
  { name: 'Terry Templates', sub: 'dev-template-editor', roles: 'template editor, drafter', does: 'Edits templates; drafts the HB 1047 note' },
  { name: 'Morgan Manager', sub: 'dev-manager', roles: 'manager', does: 'Sees the team queue and the audit log; can cancel a request' },
  { name: 'Val Viewer', sub: 'dev-viewer', roles: 'viewer', does: 'Reads approved notes beside the bill text' },
  { name: 'Ada Admin', sub: 'dev-admin', roles: 'admin', does: 'Ingest runs, audit log, templates' },
];

/** The seeded scenario (`wa-leg demo seed`), one note per workflow state. */
export const DEMO_NOTES: { bill: string; title: string; drafter: string; state: string; shows: string }[] = [
  { bill: 'HB 1004', title: 'Personal property tax exemption', drafter: 'Dana Drafter', state: 'To do', shows: 'A fresh assignment with the 72-hour clock running' },
  { bill: 'SHB 1043', title: 'Commute trip reduction tax credit', drafter: 'Dana Drafter', state: 'In progress', shows: 'A revision for the substitute; the note on HB 1043 is superseded' },
  { bill: 'ESSB 5814', title: 'Sales tax on services', drafter: 'Dana Drafter', state: 'Changes requested', shows: 'An itemised change request with a comment thread; one item already addressed' },
  { bill: 'HB 2081', title: 'B&O surcharges', drafter: 'Dana Drafter', state: 'Ready for review', shows: 'Submitted, unclaimed, and past its deadline' },
  { bill: 'SB 6137', title: 'Sports wagering', drafter: 'Jordan Both', state: 'In review', shows: 'Claimed by Rae Reviewer; no fiscal impact template' },
  { bill: 'HB 1047', title: 'Fire district equipment exemption', drafter: 'Terry Templates', state: 'Waiting for executive review', shows: 'Approved by the reviewer; chain Avery Approver then Blake Budget' },
  { bill: 'SHB 2402', title: 'Phthalates in intravenous equipment', drafter: 'Dana Drafter', state: 'Approved', shows: 'The published note every user sees beside the bill' },
  { bill: 'HB 1019', title: 'Farm equipment tax credit', drafter: 'Jordan Both', state: 'Approved', shows: 'Approved after one closed change request' },
  { bill: 'HB 1044', title: 'County REET administration fee', drafter: 'Dana Drafter', state: 'Cancelled', shows: 'Cancelled by the manager' },
  { bill: 'HB 1016', title: 'Veteran hiring credit', drafter: 'Jordan Both', state: 'To do', shows: 'Assigned an hour ago by Avery Approver' },
];

export function Guide() {
  useEffect(() => {
    document.title = 'Guide · Fiscal Note Workbench';
  }, []);
  return (
    <article className="guide">
      <h1>Guide and walkthrough</h1>
      <p>
        This page explains what the workbench does, who uses it, and how to try each part with the test users and the seeded notes. It takes about
        twenty minutes to walk through end to end.
      </p>
      <nav aria-label="On this page" className="guide-toc">
        <a href="#purpose">Purpose</a> · <a href="#people">People and roles</a> · <a href="#users">Test users</a> · <a href="#setup">Setup and seed data</a> ·{' '}
        <a href="#walkthrough">Walkthrough</a> · <a href="#changes">Change requests</a> · <a href="#checks">What to check</a> · <a href="#statuses">Status vocabulary</a>
      </nav>

      <h2 id="purpose">Purpose</h2>
      <p>
        A fiscal note states what a bill would do to an agency’s revenue and costs. The Department of Revenue writes several hundred of them each
        session, each against a specific version of a bill, on a 72-hour clock. The workbench keeps the bill text and the note side by side, records who
        asked for what and when, and publishes the approved note next to the bill for everyone who needs to read it.
      </p>
      <ul>
        <li>
          <strong>Bills.</strong> Every bill of the biennium with its versions, amendments, hearings and prior published notes. The viewer shows an
          outline, the sections affected, a version switcher and a redline between versions.
        </li>
        <li>
          <strong>Notes.</strong> A note is drafted from a template into a structured document: header fields, the Part I estimate tables that add
          themselves up, narrative parts, citations into the bill, formulas and comments. Every save is a version.
        </li>
        <li>
          <strong>Workflow.</strong> One state per note revision, from <em>To do</em> to <em>Approved</em>, with a drafter, a reviewer, an optional
          executive review chain and three deadlines: the statutory 72 hours, the hearing cutoff and any due time an assigner sets.
        </li>
        <li>
          <strong>Publishing.</strong> Approval freezes the document. It appears beside the bill for every signed-in user and exports to PDF, DOCX, HTML
          and a placeholder of the OFM fiscal note system XML.
        </li>
      </ul>

      <h2 id="people">People and roles</h2>
      <table className="guide-table">
        <thead>
          <tr>
            <th scope="col">Persona</th>
            <th scope="col">Starts at</th>
            <th scope="col">What they do</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Drafter</td>
            <td>
              <Link to="/dashboard/drafter">Drafting dashboard</Link>
            </td>
            <td>Reads the bill, writes the note against one version, answers review comments, addresses change requests, resubmits.</td>
          </tr>
          <tr>
            <td>Reviewer / assigner</td>
            <td>
              <Link to="/dashboard/reviewer">Review dashboard</Link>
            </td>
            <td>Creates the request from a bill, assigns the drafter, claims the review, comments, requests changes or approves, sets the executive chain.</td>
          </tr>
          <tr>
            <td>Executive reviewer</td>
            <td>Inbox link</td>
            <td>Completes or returns their step of the executive review chain, in order.</td>
          </tr>
          <tr>
            <td>Manager</td>
            <td>Review dashboard</td>
            <td>Sees the whole team queue, reassigns, cancels, reads the audit log.</td>
          </tr>
          <tr>
            <td>Reader</td>
            <td>Search, then the bill page</td>
            <td>Reads the approved note beside the bill text and exports it. Nothing to edit.</td>
          </tr>
          <tr>
            <td>Admin and template editor</td>
            <td>Ingest, Audit, Templates</td>
            <td>Loads bill data, reviews the audit log, edits the templates a note starts from.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="users">Test users</h2>
      <p>
        Sign-in goes through a development identity provider that lists these users. Each has a fixed set of roles. Pick one from the list, or
        open <code>/api/v1/auth/login?login_hint=dev-drafter</code> to skip the picker.
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

      <h2 id="setup">Setup and seed data</h2>
      <p>The seeded scenario puts one note in every workflow state, each on a different bill, so every dashboard section has something in it:</p>
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
            <tr key={n.bill + n.state}>
              <td>
                {n.bill}
                <div className="muted small">{n.title}</div>
              </td>
              <td>{n.drafter}</td>
              <td>{n.state}</td>
              <td>{n.shows}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>To rebuild it from a clean database:</p>
      <pre tabIndex={0} aria-label="Setup commands">
        {`docker compose up -d
pnpm wa-leg db migrate && pnpm wa-leg db seed
pnpm wa-leg ingest legiscan data/WA/2025-2026_Regular_Session
pnpm wa-leg search init && pnpm wa-leg search load
pnpm wa-leg demo seed --reset
pnpm dev`}
      </pre>
      <p>
        The ingest loads every bill of the session; the demo needs HB 1004, HB 1016, HB 1019, HB 1043, HB 1044, HB 1047, HB 2081, HB 2402, SB 5814 and SB
        6137 and skips any that are missing. The seed refuses to run on top of existing notes unless <code>--reset</code> is given. Email copies of
        every notification land in the mail sink at <code>http://localhost:8026</code>.
      </p>

      <h2 id="walkthrough">Walkthrough</h2>
      <h3>1. Reviewer: the queue and a new request (Rae Reviewer)</h3>
      <ol>
        <li>
          Open the <Link to="/dashboard/reviewer">Review dashboard</Link>. <em>Pending my review</em> lists HB 2081 (unclaimed, overdue) and SB 6137 (claimed).{' '}
          <em>Changes requested</em> lists ESSB 5814. The team queue groups every note by status.
        </li>
        <li>
          Search for <code>hb 1483</code> or any other bill and open it. In the right pane, <strong>New fiscal note</strong> asks for the version, a
          template, the drafter, the request id and the legislative contact. <strong>Create and open</strong> lands in the workspace at <em>To do</em>.
        </li>
        <li>
          In the bill viewer on the left: the outline names each section by its RCW caption, or a bracketed paraphrase for new sections; the version
          switcher and <strong>Compare</strong> show a redline; <kbd>j</kbd> and <kbd>k</kbd> move between sections.
        </li>
      </ol>
      <h3>2. Drafter: write a note (Dana Drafter)</h3>
      <ol>
        <li>
          The <Link to="/dashboard/drafter">Drafting dashboard</Link> lists HB 1004 (To do), SHB 1043 (In progress) and ESSB 5814 (Changes requested) under{' '}
          <em>needing action</em>, HB 2081 under <em>waiting on others</em>, and SHB 2402 under <em>recently approved</em>. The inbox holds the
          assignments and the change request.
        </li>
        <li>
          Open HB 1004. Unfilled slots carry a dashed outline and a hint; <kbd>Tab</kbd> moves to the next one. Type <code>-4310000</code> into a cash
          receipts cell: totals recompute and the cell formats as <code>(4,310,000)</code> when you leave it. The first save moves the note to{' '}
          <em>In progress</em>.
        </li>
        <li>
          <strong>Cite</strong> in the bill’s section bar drops a citation at the caret; clicking a citation scrolls the bill to that section.{' '}
          <strong>Formula</strong> inserts LaTeX rendered with KaTeX. <strong>Versions</strong> compares any two saves as a redline with a cell diff.
        </li>
        <li>
          <strong>Submit for review</strong> with a comment. The editor turns read-only and the reviewer is notified.
        </li>
      </ol>
      <h3 id="changes">3. Change requests (Rae Reviewer, then Dana Drafter)</h3>
      <ol>
        <li>
          As Rae, open SB 6137 (In review). Select a sentence in the note and press <strong>Comment</strong> to start a thread on it. Then press{' '}
          <strong>Request changes</strong>: write a summary and one line per item starting with <code>-</code>. Open comment threads are attached as
          items too.
        </li>
        <li>
          As Dana, open ESSB 5814. A banner names the reviewer, the date and the count of open items; the <strong>Changes</strong> tab lists the request:
          the summary, each item, and for thread items a link to the commented text. One item is already addressed.
        </li>
        <li>
          Edit the note, then <strong>Mark addressed</strong> on each item and say what changed and where. The linked comment thread gets that answer
          and is resolved. <strong>Submit for review</strong> is blocked until every item is addressed.
        </li>
        <li>
          <strong>Close request</strong> with a note to the reviewer, then submit. The closed request keeps every resolution, the document version each
          one cites, and a link that compares the version the reviewer saw with the version that answered it.
        </li>
        <li>
          As Rae, claim the review again. The Changes tab shows the resolutions; <strong>Reopen</strong> on an item sends it back. Approve, or set an
          executive review chain under <strong>Assign</strong> first.
        </li>
      </ol>
      <h3>4. Executive review and publishing (Avery Approver, Blake Budget, Val Viewer)</h3>
      <ol>
        <li>
          As Avery, the inbox links to HB 1047 at step 1 of 2. <strong>Start executive review</strong>, then <strong>Executive review done</strong>. As Blake,
          complete step 2: the note is <em>Approved</em>.
        </li>
        <li>
          As Val, open SHB 2402. The <strong>Fiscal note</strong> panel shows the approved note beside the text with PDF, DOCX and HTML links. Switch the
          version to HB 2402: the panel explains it is showing the note for the later version. Narrow the window: the panes stack behind tabs.
        </li>
      </ol>
      <h3>5. Administration (Ada Admin, Morgan Manager, Terry Templates)</h3>
      <ol>
        <li>
          <Link to="/admin/audit">Audit</Link> filters by note id and shows creation, saves, transitions, change requests, exports and denied actions.
        </li>
        <li>
          <Link to="/admin/ingest">Ingest</Link> lists runs and refreshes bills against the legislature’s file service.
        </li>
        <li>
          <Link to="/admin/templates">Templates</Link> previews the twelve note templates; an edit creates a new template version.
        </li>
      </ol>

      <h2 id="checks">What to check</h2>
      <ul>
        <li>The same note shows the same status on every dashboard and in the workspace bar; the hover text explains what the status means.</li>
        <li>Deadlines: each row names its band (Due later, Due within 24 hours, Due within 4 hours, Overdue). HB 2081 is overdue; ESSB 5814 is inside 24 hours.</li>
        <li>Two windows as the same drafter: edit in both, save in one, then edit in the other. The banner offers <strong>Reload theirs</strong> or <strong>Keep mine</strong>.</li>
        <li>A viewer cannot open a note that is not approved, and cannot comment.</li>
        <li>Every page passes axe at phone and desktop widths; the outline, the section bar and the editor work from the keyboard.</li>
        <li>Exports: the PDF has Letter pages and the request number in the footer; the DOCX with comments carries the threads as Word comments.</li>
      </ul>

      <h2 id="statuses">Status vocabulary</h2>
      <p>One word per workflow state, used everywhere:</p>
      <table className="guide-table">
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Meaning</th>
            <th scope="col">Who acts</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>To do</td>
            <td>Assigned; the drafter has not started</td>
            <td>Drafter</td>
          </tr>
          <tr>
            <td>In progress</td>
            <td>The drafter is writing</td>
            <td>Drafter</td>
          </tr>
          <tr>
            <td>Ready for review</td>
            <td>Submitted; waiting for a reviewer to claim it</td>
            <td>Any reviewer</td>
          </tr>
          <tr>
            <td>In review</td>
            <td>A reviewer has claimed it</td>
            <td>That reviewer</td>
          </tr>
          <tr>
            <td>Changes requested</td>
            <td>Back with the drafter, with an itemised request in the Changes tab</td>
            <td>Drafter</td>
          </tr>
          <tr>
            <td>Waiting for executive review / In executive review</td>
            <td>Approved by the reviewer; moving through the executive chain</td>
            <td>The current chain member</td>
          </tr>
          <tr>
            <td>Approved</td>
            <td>Published beside the bill</td>
            <td>Nobody (an approver may reopen)</td>
          </tr>
          <tr>
            <td>Cancelled, Superseded</td>
            <td>Withdrawn, or replaced by a revision for a newer bill version</td>
            <td>Nobody</td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}
