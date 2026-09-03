# Demo script

Five notes on five bills, one in each status. About ten minutes. The in-app guide at `/guide` carries the
same walkthrough with links; `apps/web/src/lib/demo.ts` is the source of the user and note lists shown there
and on the landing page.

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
HB1004,HB1019,HB2081,HB2402,SB5814` loads only the demo bills; the seed skips any that are missing). The seed
refuses to run on top of existing notes without `--reset`.

Open http://localhost:5173. The landing page lists the test users; `?login_hint=dev-drafter` on
`/api/v1/auth/login` skips the picker.

## Test users

| User | Sign-in id | Roles | In the demo |
|---|---|---|---|
| Dana Drafter | `dev-drafter` | drafter | Writes the notes on HB 1004, HB 2081, ESSB 5814 and SHB 2402 |
| Rae Reviewer | `dev-reviewer` | reviewer | Creates notes, reviews, requests changes, approves, publishes |
| Cam Committee | `dev-committee` | viewer | Reads published notes and their exports |
| Jordan Both | `dev-both` | drafter, reviewer | Drafts the HB 1019 note; reviews as Rae does |

## The seeded notes

| Bill | Drafter | Status | Shows |
|---|---|---|---|
| HB 1004, personal property tax exemption | Dana Drafter | Draft | Created by Rae for Dana; Dana has started the narrative |
| HB 2081, B&O surcharges | Dana Drafter | In review | Submitted by Dana with a message; no reviewer has acted yet |
| ESSB 5814, sales tax on services | Dana Drafter | Changes requested | Rae requested changes with a message; two open comment threads for Dana to resolve |
| HB 1019, farm equipment tax credit | Jordan Both | Approved | Approved by Rae after one round of changes; History holds the request and the reply |
| SHB 2402, phthalates in intravenous equipment | Dana Drafter | Published | Published by Rae; beside the bill and on the Published page with four export links |

## 1. Create (Rae Reviewer)

1. Sign in as Rae. **Notes** lists every note grouped by status: bill, title, status, drafter, reviewer,
   updated.
2. Search `hb 1483` and open the bill. The outline names every section (RCW caption, or a bracketed paraphrase
   for a new section, with *NEW SECTION* before the number); the sticky section bar shows the subject; `j`/`k`
   move between sections; the version switcher and **Compare** are in the header.
3. **New fiscal note** in the right pane asks for the bill version, a template and the drafter
   ([screenshot](acceptance/0.2/01-rae-new-note-form.png)). Choose Dana. **Create and open** lands in the
   workspace with the note in *Draft*. A drafter can also create a note on a bill; the form then has no drafter
   field and the note is theirs.

## 2. Draft (Dana Drafter)

1. Sign in as Dana. **Notes** lists HB 1004, HB 2081, ESSB 5814 and SHB 2402. Open HB 1004 (Draft).
2. The bill is on the left, the note on the right. Unfilled slots carry a dashed outline and a hint; `Tab`
   moves to the next one. Type `-4310000` into a cash receipts cell: totals recompute and the cell formats as
   `(4,310,000)`.
3. **Cite** in the bill's section bar inserts a citation at the caret; clicking it scrolls the bill pane to
   the section. A second **Cite** on the same section selects the existing citation and shows *Already cited*
   ([screenshot](acceptance/0.2/05-dana-already-cited.png)). The `×` on a citation removes it.
4. Select a sentence and press **Comment** to start a thread on it. The *Comments* tab lists the threads.
5. The note saves itself 1.5 s after the last change.

## 3. Submit (Dana Drafter)

1. **Submit for review** in the workflow bar; the message is optional. Status: *In review*.
2. The editor is read-only until a reviewer acts. HB 2081 is seeded in this status.

## 4. Review and request changes (Rae Reviewer)

1. Sign in as Rae and open HB 2081 from **Notes**. The workflow bar shows the bill, the status with its hint,
   the drafter and the reviewer.
2. Comment on two sentences.
3. **Request changes** and write a message; the message is required. The dialog has one **Cancel** button
   and no workflow action is labelled Cancel
   ([screenshot](acceptance/0.2/10-rae-request-changes-dialog-one-cancel.png)). Status: *Changes requested*.
   Rae is now the note's reviewer.
4. ESSB 5814 is seeded in this status with Rae's message and two open threads.

## 5. Resolve and resubmit (Dana Drafter)

1. Sign in as Dana and open ESSB 5814. A banner shows who requested changes, when, the message, and *2 open
   comment threads* with a link to the Comments tab
   ([screenshot](acceptance/0.2/12-dana-change-request-banner.png)).
2. Resolve both threads, edit the note, then **Submit for review** with a reply.
3. Status: *In review*. **History** lists the request and the reply.

## 6. Approve (Rae Reviewer)

1. Sign in as Rae and open the note. **Approve**. Status: *Approved*; the document is frozen at the approved
   version.
2. **Export** in the workflow bar produces PDF, DOCX, HTML and XML of the approved version
   ([screenshot](acceptance/0.2/14-rae-approved-export-menu.png)). HB 1019 is seeded in this status after one
   round of changes.

## 7. Publish (Rae Reviewer)

1. **Publish**. Status: *Published*. A published note never changes; a correction is a new note on the same
   bill version.
2. **Published** lists it newest first with the four export links. SHB 2402 is seeded in this status.

## 8. Read as the Committee (Cam Committee)

1. Sign in as Cam. The landing page goes to **Published**: bill, version, title, published date, and PDF,
   DOCX, HTML and XML links for each note ([screenshot](acceptance/0.2/16-cam-published-list.png)).
2. Open SHB 2402 (`/bills/2025-26/HB2402/S`). The **Fiscal note** panel shows the published note beside the
   bill text with the same links ([screenshot](acceptance/0.2/17-cam-bill-page-published-panel.png)). Switch
   the version to HB 2402: the panel says it is showing the SHB 2402 note. Narrow the window: the panes stack
   behind *Bill* and *Fiscal note* tabs.
3. Cam cannot open notes that are not published. `GET /api/v1/published` returns the same list for a
   downstream system (`PUBLISHED-API.md`); the PDF downloads as `HB2402-S-fiscal-note.pdf`.

## Statuses

| Status | Meaning | Who acts |
|---|---|---|
| Draft | The drafter is writing | Drafter: Submit for review |
| In review | A reviewer is reading it | Reviewer: Request changes or Approve |
| Changes requested | Back with the drafter, with the reviewer's message and the open comment threads | Drafter: Submit for review |
| Approved | Frozen at the approved version | Reviewer: Publish |
| Published | Available to the Committee beside the bill and on the Published page, in every export format | Nobody |

The acceptance run of this script is in `acceptance/0.2/` (17 screenshots, `01-rae-new-note-form.png` to
`17-cam-bill-page-published-panel.png`).
