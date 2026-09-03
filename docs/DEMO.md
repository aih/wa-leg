# Demo script

Three personas, one bill: SHB 2402 (phthalates in medical equipment). About twenty minutes.

## Setup

```sh
docker compose up -d
pnpm wa-leg db migrate && pnpm wa-leg db seed
pnpm wa-leg ingest legiscan data/WA/2025-2026_Regular_Session --bills HB2402,SB6137,HB2205
pnpm wa-leg search init && pnpm wa-leg search load
pnpm dev
```

Open http://localhost:5173. The dev sign-in page lists the test users; `?login_hint=dev-drafter` skips it.
The mail sink is at http://localhost:8026.

## 1. Reviewer: assign the request (Rae Reviewer)

1. Type `shb 2402` in the search box and press Enter. The substitute opens at the current version.
2. Show the bill viewer: outline, RCW affected, the sticky section bar, keyboard `j`/`k`, the version switcher
   and **Compare** (SHB 2402 against HB 2402 shows the redline).
3. In the right pane, open **New fiscal note**: template *Sales and use tax exemption*, drafter *Dana Drafter*,
   request id `2402-1-1`, contact and phone. **Create and open**.
4. The workspace opens with the workflow bar: state *To do*, the 72-hour due countdown, drafter Dana. Rae is
   read-only here. Point at **Assign** (reassign, set an Executive Review chain) and **History**.
5. Open the **Review dashboard**: the note sits in the team queue under *To do*; *Unassigned bills with hearings
   within 72 hours* lists bills that still need a note.

## 2. Drafter: write the note (Dana Drafter)

1. Sign in as Dana. The **Drafter dashboard** shows the note under *My notes needing action* as *To do* with
   its due band. The inbox badge shows the assignment; open **Inbox** to show the message (also in the mail sink).
2. Open the note. Unfilled slots carry dashed outlines and hints; the status bar counts required slots.
3. Click into the cash receipts table, type `-4310000` in FY 2026, `Tab`, `-10800000` in FY 2027. Biennium
   totals and the Total row update; the cells format as `(4,310,000)` when the cursor leaves.
4. In the bill pane, go to section 2 and press **Cite**: a citation `Sec. 2` lands at the caret. Click it: the
   bill pane scrolls to the section.
5. **Formula**: type `\frac{a}{b} \times 10^{3}` in the LaTeX view (or use the MathLive field) and insert.
6. Fill the narrative slots. Watch the status bar: *Saving…* then *Saved at …*. Show **Versions**: autosaves,
   **Compare with previous** shows the redline and the cell diff; **Save version** names a snapshot.
7. Conflict: in a second window (same user) edit and save, then edit in the first: the banner offers
   **Reload theirs** or **Keep mine**.
8. **Submit for review** with a comment. The state becomes *Ready for review*; the editor turns read-only.

## 3. Reviewer: review and approve (Rae Reviewer)

1. Rae's dashboard lists the note under *Pending my review* (unclaimed). Open it, **Claim review**.
2. Select a sentence and press **Comment**; write the request. **Request changes** with a comment: the state
   becomes *Changes requested* and Dana is notified.
3. As Dana: the thread is in **Comments**, the note is editable again; reply, resolve, **Submit for review**.
4. As Rae: **Claim review**, optionally **Assign** an Executive Review chain (Avery Approver, then Blake
   Budget) and **Approve**. With a chain the note moves to *Waiting for executive review*; each approver
   claims and completes their step from their inbox link. Without a chain the note is *Approved*.
5. **History** shows every transition with actor, time and comment, plus the audit trail.

## 4. Viewer: read the approved note (Val Viewer)

1. Sign in as Val and open SHB 2402. The **Fiscal note** panel shows the approved note beside the bill text,
   with **PDF**, **DOCX** and **HTML** links; the OFM-published packages are linked below it.
2. Open the PDF: Letter pages, tables, the formula, the FN footer with the request number.
3. Narrow the window to a phone width: the panes stack behind *Bill* and *Fiscal note* tabs.
4. Switch the version switcher to HB 2402 (introduced): the panel explains that it is showing the note for the
   later version.

## 5. Administration (Ada Admin)

1. **Audit**: filter by the note id to see creation, saves, transitions, exports and any permission denials.
2. **Ingest**: run history and a refresh against lawfilesext.
3. **Templates** (Terry Templates): the twelve templates with preview and an edit that creates a new version.
