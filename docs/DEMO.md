# Demo script

Ten notes on ten bills, one in each workflow state. About twenty minutes. The in-app guide at `/guide` carries
the same walkthrough with links.

## Setup

```sh
docker compose up -d
pnpm wa-leg db migrate && pnpm wa-leg db seed
pnpm wa-leg ingest legiscan data/WA/2025-2026_Regular_Session
pnpm wa-leg search init && pnpm wa-leg search load
pnpm wa-leg demo seed --reset
pnpm dev
```

The ingest loads every bill of the session (about twenty minutes against lawfilesext; `--bills
HB1004,HB1016,HB1019,HB1043,HB1044,HB1047,HB2081,HB2402,SB5814,SB6137` loads only the demo bills). The seed
refuses to run on top of existing notes without `--reset`.

Open http://localhost:5173. The landing page lists the test users; `?login_hint=dev-drafter` on
`/api/v1/auth/login` skips the picker. The mail sink is at http://localhost:8026.

## The seeded notes

| Bill | Drafter | Status | Shows |
|---|---|---|---|
| HB 1004, personal property tax exemption | Dana Drafter | To do | Assigned three hours ago; 72-hour clock running |
| SHB 1043, commute trip reduction credit | Dana Drafter | In progress | Revision for the substitute; the HB 1043 note is superseded |
| ESSB 5814, sales tax on services | Dana Drafter | Changes requested | Two bullet items and a comment thread; one item addressed; due within 24 hours |
| HB 2081, B&O surcharges | Dana Drafter | Ready for review | Submitted, unclaimed, overdue, priority urgent |
| SB 6137, sports wagering | Jordan Both | In review | Claimed by Rae Reviewer; no fiscal impact |
| HB 1047, fire district equipment exemption | Terry Templates | Waiting for executive review | Chain Avery Approver, then Blake Budget |
| SHB 2402, phthalates in intravenous equipment | Dana Drafter | Approved | The published note beside the bill |
| HB 1019, farm equipment credit | Jordan Both | Approved | Approved by Avery after one closed change request |
| HB 1044, county REET fee | Dana Drafter | Cancelled | Cancelled by Morgan Manager |
| HB 1016, veteran hiring credit | Jordan Both | To do | Assigned an hour ago by Avery Approver |

## 1. Reviewer: the queue and a new request (Rae Reviewer)

1. The **Review dashboard** opens. *Pending my review* holds HB 2081 (unclaimed, overdue) and SB 6137
   (claimed). *Changes requested, waiting on the drafter* holds ESSB 5814. The team queue groups every note by
   status with a reassign control.
2. Search `hb 1483` and open the bill. Show the viewer: the outline names every section (RCW caption, or a
   bracketed paraphrase for a new section, with *NEW SECTION* before the number), RCW affected, the sticky
   section bar with the subject, `j`/`k`, the version switcher and **Compare**.
3. **New fiscal note** in the right pane: version, template, drafter Dana, request id, contact. **Create and
   open** lands in the workspace at *To do* with the due countdown. **Assign** sets a due time or an executive
   chain; **History** lists transitions and the audit trail.

## 2. Drafter: write a note (Dana Drafter)

1. The **Drafting dashboard**: HB 1004 (To do), SHB 1043 (In progress) and ESSB 5814 (Changes requested) under
   *needing action*, HB 2081 under *waiting on others*, SHB 2402 under *recently approved*. The inbox holds the
   assignments and the change request; each also went to the mail sink.
2. Open HB 1004. Unfilled slots carry dashed outlines and hints; the status bar counts required slots. Type
   `-4310000` in a cash receipts cell, `Tab`, `-10800000`: totals recompute and cells format as `(4,310,000)`.
   The first save moves the note to *In progress*.
3. **Cite** in the bill's section bar inserts a citation; clicking it scrolls the bill. **Formula** inserts
   LaTeX rendered with KaTeX. **Versions** compares two saves as a redline with a cell diff.
4. Conflict: in a second window (same user) edit and save, then edit in the first: **Reload theirs** or **Keep
   mine**.
5. **Submit for review** with a comment. The editor turns read-only.

## 3. Change requests (Rae Reviewer, then Dana Drafter)

1. As Rae, open SB 6137 (*In review*). Select a sentence, **Comment**, write the note. **Request changes**: a
   summary line plus one line per item starting with `-`. Open threads are attached as items. The state becomes
   *Changes requested* on every dashboard.
2. As Dana, open ESSB 5814. The banner names the reviewer, the date and *2 of 3 still open*; **Review and
   address** opens the **Changes** tab: the summary, three items (two from the comment, one linked to the
   thread on "The impact of the temporary staffing provision is indeterminate"), one already addressed with its
   resolution and document version.
3. Press **Submit for review**: refused while items are open. Edit the note, then **Mark addressed** on each
   item with what changed and where. The thread item's answer appears in the comment thread, which is resolved.
4. **Close request** with a message to the reviewer, then **Submit for review**. The closed request keeps every
   resolution and links to the version comparison between the version the reviewer saw and the one that
   answered it.
5. As Rae, **Claim review**. The Changes tab shows the resolutions; **Reopen** on an item sends it back with a
   reason. **Approve**, or set an executive chain under **Assign** first.

## 4. Executive review and publishing (Avery Approver, Blake Budget, Val Viewer)

1. As Avery, the inbox links to HB 1047 at step 1 of 2. **Start executive review**, **Executive review done**.
   As Blake, complete step 2: *Approved*.
2. As Val, open SHB 2402. The **Fiscal note** panel shows the approved note beside the text with **PDF**,
   **DOCX** and **HTML**. Switch to HB 2402: the panel says it is showing the note for the later version. Narrow
   the window: the panes stack behind *Bill* and *Fiscal note* tabs.

## 5. Administration (Ada Admin, Morgan Manager, Terry Templates)

1. **Audit**: filter by note id to see creation, saves, transitions, change requests, exports and denied
   actions.
2. **Ingest**: run history and a refresh against lawfilesext.
3. **Templates**: the twelve templates with preview; an edit creates a new version.
