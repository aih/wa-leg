# Fiscal Note Workbench

Proof-of-concept fiscal note drafting tool for the Washington Department of Revenue. A drafter reads a bill,
writes the fiscal note against a specific bill version, a reviewer approves it, and end users read the approved
note beside the bill text. The design is in `design/`; `design/ARCHITECTURE.md` is the specification.

## Layout

| Path | Contents |
|---|---|
| `apps/api` | Fastify service under `/api/v1`; OpenAPI at `/api/v1/openapi.json`; the `wa-leg` CLI |
| `apps/web` | React 19 + Vite + React Router web app |
| `apps/dev-oidc` | Development OpenID Connect issuer with one test user per role |
| `packages/workflow-machine` | XState v5 review workflow, shared by server and client |
| `packages/billref` | Bill reference parser |
| `packages/bill-document` | Bill Document schema, XML parser, section diff |
| `packages/note-schema` | Tiptap extensions, template loader, estimate validator |
| `packages/api-client` | Client generated from the OpenAPI document |
| `docs/` | `ARCHITECTURE-AS-BUILT.md`, `DEMO.md`, `LOAD-TEST.md`, `OPEN-ITEMS.md` |

## Development

Requirements: Node 22, pnpm 11 (`corepack enable`), Docker.

```sh
cp .env.example .env
docker compose up -d            # Postgres 5433, OpenSearch 9201, mail sink 8026, dev OIDC 4801
pnpm install
pnpm wa-leg db migrate
pnpm wa-leg db seed
pnpm dev                        # API on 4800, web on 5173, dev OIDC on 4801
```

Open http://localhost:5173 and sign in. The dev issuer lists the test users:

| User | Roles |
|---|---|
| Dana Drafter | drafter |
| Rae Reviewer | reviewer |
| Avery Approver | reviewer, approver |
| Morgan Manager | manager |
| Val Viewer | viewer |
| Terry Templates | template_editor, drafter |
| Ada Admin | admin |
| Jordan Both | drafter, reviewer |
| Blake Budget | reviewer, approver (Budget division) |

`?login_hint=dev-drafter` on `/api/v1/auth/login` skips the picker.

## Drafting a note

1. Sign in as Rae Reviewer, open a bill (`/bills/2025-26/HB2402/S`), and use **New fiscal note** beside the text:
   choose the bill version, a template, and the drafter.
2. Sign in as Dana Drafter and open the note from the drafter dashboard. The workspace shows the bill on the
   left and the editor on the right. Unfilled slots carry a dashed outline and their hint; `Tab` moves to the
   next slot (inside a table, to the next cell) and `Ctrl+]` to the next unfilled one. Computed cells and
   biennium totals update as figures are typed; numbers format as currency when the cursor leaves the cell.
3. **Cite** in the bill's section bar, or the floating Cite control on a selection, inserts a citation node at
   the caret. Clicking a citation scrolls the bill pane to the section.
4. **Formula** opens the MathLive field (with a LaTeX source view); the result renders with KaTeX.
5. Autosave runs 1.5 s after the last change with `If-Match`. A `412` shows a banner with the other saver's
   name and offers **Reload theirs** or **Keep mine** (a forced save that keeps the server head as a snapshot).
6. **Comment** on a selection opens a thread in the Comments tab; threads follow the text through edits and
   are listed as detached if the text is deleted.
7. **Versions** lists autosaves and named snapshots, renders any version, compares two as a redline with a
   table-cell diff, and restores a version as a new head.

## Review workflow

Each note revision has one workflow instance (`todo`, `in_progress`, `review.pending`, `review.active`,
`changes_requested`, `exec_review.pending`, `exec_review.active`, `approved`, `cancelled`, `superseded`). The
workspace bar shows the state, the due countdown with its band as text, the assignees, and the buttons the
signed-in user may press: the drafter starts and submits; a reviewer claims, requests changes (a comment is
required) or approves; an approver in the Executive Review chain claims, completes or returns each step in
order. Assigners (reviewer, manager, admin) use **Assign** to set the drafter, reassign, or set the chain.

Deadlines: the statutory clock (request time + 72 hours, `STATUTORY_HOURS`), the hearing cutoff (next hearing
minus `HEARING_LEAD_HOURS`), and a per-assignment due time. A poller (`DEADLINE_POLL_MS`) emits due-soon and
overdue events; dashboards sort by the earliest deadline and label the band (`Due later`, `Due within 24
hours`, `Due within 4 hours`, `Overdue`). Notifications land in the inbox and, when `NOTIFY_EMAIL` is on, in
the SMTP sink at http://localhost:8026.

When the bills ingest adds a new version of a bill with an open note, the drafter is notified and the
workspace offers **Create revision**; the new revision starts in `todo` with the same drafter and chain, and
the old one becomes `superseded`.

## Publishing and export

Approval freezes the head document as the approved version. The bill page shows that version beside the text
for every signed-in user; when the selected bill version has no approved note, the panel shows the latest
approved note for an earlier version and says so. Exports (`GET` or `POST /notes/{id}/export?format=`):

| Format | Renderer | Notes |
|---|---|---|
| `html` | note-schema HTML with KaTeX | Citation links point at the workbench; `comments=true` keeps comment marks and lists the threads |
| `pdf` | Playwright Chromium from the HTML | Letter, 1-inch margins, footer with the request and bill numbers |
| `docx` | `docx` mapper from ProseMirror JSON | Tables with repeated header rows, bold totals, formulas as Office Math (a LaTeX subset), `comments=true` emits Word comments |
| `xml` | placeholder FNS mapper | Slot values, Part I tables from the estimate data, narrative parts as HTML; refuses (422) while required slots are empty |

Viewers get the approved version; participants get the head unless `version=` names another. Every export
writes a `note_exports` row, an audit row, and a `note.exported` event. `/admin/audit` in the web app lists
the audit log for admins and managers. Set `PDF_ENABLED=false` where Chromium is unavailable.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test                       # unit and route tests; needs Postgres (creates wa_leg_test)
pnpm test:e2e                   # Playwright; starts the dev issuer, API, and web app
pnpm third-party                # writes THIRD_PARTY.md and fails on a non-permissive license
pnpm --filter @wa-leg/api-client generate   # regenerates packages/api-client from the OpenAPI document
pnpm load                       # autocannon against the running API; writes docs/LOAD-TEST.md
```

`docs/` holds the as-built architecture notes, the demo script, the load-test results, and the open items.
The admin pages are `/admin/audit` (admin, manager), `/admin/ingest` (admin) and `/admin/templates`
(template_editor). `pnpm wa-leg token --user dev-viewer` prints a bearer token for scripts.

## Data

Unzip the Legiscan dataset to `data/` and load it:

```sh
unzip WA_2025-2026_Regular_Session_JSON_*.zip -d data
pnpm wa-leg ingest legiscan data/WA/2025-2026_Regular_Session --limit 20
pnpm wa-leg search init
pnpm wa-leg search load
```
