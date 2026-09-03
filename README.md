# Fiscal Note Workbench

Proof-of-concept fiscal note drafting tool for the Washington Department of Revenue. A drafter writes the note
against a specific bill version, a reviewer requests changes or approves it, and the published note is
available beside the bill, on the Published page and through an API in PDF, DOCX, HTML and XML.
`docs/SIMPLIFY-0.2.md` is the current design; `design/` holds the original research and specification.

## Layout

| Path | Contents |
|---|---|
| `apps/api` | Fastify service under `/api/v1`; OpenAPI at `/api/v1/openapi.json`; the `wa-leg` CLI |
| `apps/web` | React 19 + Vite + React Router web app |
| `apps/dev-oidc` | Development OpenID Connect issuer with the four test users |
| `packages/workflow-machine` | Transition table for the review workflow, shared by server and client |
| `packages/billref` | Bill reference parser |
| `packages/bill-document` | Bill Document schema, XML parser, section diff |
| `packages/note-schema` | Tiptap extensions, template loader, estimate validator |
| `packages/api-client` | Client generated from the OpenAPI document |
| `docs/` | `ARCHITECTURE-AS-BUILT.md`, `DEMO.md`, `PUBLISHED-API.md`, `DEPLOY.md`, `RELEASE.md`, `LOAD-TEST.md`, `OPEN-ITEMS.md`, `SIMPLIFY-0.2.md` |

## Development

Requirements: Node 22, pnpm 11 (`corepack enable`), Docker.

```sh
cp .env.example .env
docker compose up -d            # Postgres 5433, OpenSearch 9201, dev OIDC 4801
pnpm install
pnpm wa-leg db migrate
pnpm wa-leg db seed
pnpm dev                        # API on 4800, web on 5173, dev OIDC on 4801
```

Open http://localhost:5173. The landing page describes the path and lists the test users; `/guide` is the
walkthrough. The dev issuer offers four users:

| User | Sign-in id | Roles |
|---|---|---|
| Dana Drafter | `dev-drafter` | drafter |
| Rae Reviewer | `dev-reviewer` | reviewer |
| Cam Committee | `dev-committee` | viewer |
| Jordan Both | `dev-both` | drafter, reviewer |

`?login_hint=dev-drafter` on `/api/v1/auth/login` skips the picker. `pnpm wa-leg token --user dev-committee`
prints a bearer token for scripts.

## Demo data

`pnpm wa-leg demo seed --reset` creates five notes on five bills, one in each status, as the test users
(`--reset` deletes existing notes first): HB 1004 (Draft), HB 2081 (In review), ESSB 5814 (Changes requested),
HB 1019 (Approved) and SHB 2402 (Published). The seed drives the HTTP API, so every note carries its
transitions, comments, audit rows and, for ESSB 5814, the reviewer's change request. `docs/DEMO.md` lists what
each note shows.

## The path

A note has one of five statuses: Draft, In review, Changes requested, Approved, Published. Four events move it
along: `SUBMIT` (drafter), `REQUEST_CHANGES` (reviewer, message required), `APPROVE` (reviewer), `PUBLISH`
(reviewer). A published note never changes; a correction is a new note on the same bill version.

1. A reviewer opens a bill (`/bills/2025-26/HB2402/S`) and uses **New fiscal note** beside the text: bill
   version, template, drafter. A drafter can create a note on a bill for themselves. The note starts in Draft.
2. The drafter opens it from `/notes`. The workspace shows the bill on the left and the note on the right, with
   the tabs *Note* and *Comments*. Unfilled slots carry a dashed outline and their hint; `Tab` moves to the next
   slot. Computed cells and biennium totals update as figures are typed.
3. **Cite** in the bill's section bar inserts a citation node at the caret. A citation shows a `×` control
   while the note is editable. Citing a section that is already cited selects the existing citation and shows
   *Already cited*.
4. Autosave runs 1.5 s after the last change with `If-Match`. A `412` shows the banner *This note was saved
   elsewhere* with one button, **Reload**.
5. **Comment** on a selection opens a thread in the Comments tab; threads follow the text through edits and
   are listed as detached if the text is deleted.
6. **Submit for review** (message optional). The editor is read-only while the note is In review.
7. The reviewer comments and presses **Request changes** with a message, or **Approve**. A change request
   shows the drafter a banner with the reviewer, the date, the message and the count of open comment threads.
   The drafter resolves the threads, edits and submits again with a reply; History lists the request and the
   reply.
8. Approval freezes the head document as the approved version. **Publish** records the publication on the
   revision (`publishedAt`, `publishedBy`, `publishedVersion`).

## Screens

| Route | Who | Content |
|---|---|---|
| `/` | Everyone | Landing page; signed-in drafters and reviewers go to `/notes`, viewers to `/published` |
| `/guide` | Everyone | The walkthrough |
| `/notes` | Drafter, reviewer | The notes the user can see, grouped by status in path order |
| `/published` | Everyone signed in | Published notes newest first with PDF, DOCX, HTML and XML links |
| `/bills/:biennium/:id[/:code]`, `/compare` | Everyone | Bill viewer; the right pane holds **New fiscal note** and the published note panel |
| `/notes/:revisionId` | Participants and reviewers; viewers once published | The workspace |
| `/search` | Everyone | Bill search |

## Publishing and export

The bill page shows the published note beside the text for every signed-in user; when the selected bill
version has no published note, the panel shows the latest published note for an earlier version and says so.
`/published` lists every published note, and `GET /api/v1/published` returns the same list for a downstream
system (`docs/PUBLISHED-API.md`). `PUBLISHED_PUBLIC=true` allows anonymous access to the feed and to the
exports of published notes.

Exports (`GET` or `POST /notes/{id}/export?format=`):

| Format | Renderer | Notes |
|---|---|---|
| `html` | note-schema HTML with KaTeX | Citation links point at the workbench |
| `pdf` | Playwright Chromium from the HTML | Letter, 1-inch margins; footer with the bill number and *Published <date>* |
| `docx` | `docx` mapper from ProseMirror JSON | Tables with repeated header rows, bold totals |
| `xml` | FNS mapper with provisional element names (`FnsXmlMapper`) | Slot values, Part I tables from the estimate data, narrative parts as HTML; `strict=true` refuses (422) while required slots are empty |

Drafters and reviewers get the head version, the approved version of an approved note, or the published
version of a published note; `version=` names another. Viewers and anonymous callers get the published
version only. File names are `{billId}-{versionCode}-fiscal-note.{ext}` (`HB2402-S-fiscal-note.pdf`;
`HB1004-fiscal-note.pdf` for an introduced bill). Set `PDF_ENABLED=false` where Chromium is unavailable.

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

## Releases

`pnpm release X.Y.Z` bumps the version, tags `vX.Y.Z`, pushes, and creates the GitHub release from
`CHANGELOG.md`; `docs/RELEASE.md` has the steps. The footer of every page and `GET /api/v1/health` show the
release number and the short commit hash of the running build.

## Data

Unzip the Legiscan dataset to `data/` and load it:

```sh
unzip WA_2025-2026_Regular_Session_JSON_*.zip -d data
pnpm wa-leg ingest legiscan data/WA/2025-2026_Regular_Session --limit 20
pnpm wa-leg search init
pnpm wa-leg search load
```

`pnpm wa-leg ingest refresh [--bills HB2402,SB5814]` re-checks stored documents against lawfilesext and
reparses the changed ones. Search indexes bills, sections, amendments, the OFM prior fiscal notes listed in
the bill data and the RCW sections a bill affects; workbench notes are found from `/notes` and `/published`.
