# Implementation prompt

Copy everything below the line into a fresh session started in this repository.

---

Build the Fiscal Note Workbench, a proof-of-concept fiscal note drafting tool for the Washington Department of Revenue. The design is complete and lives in `design/`. Read these before writing code, in this order: `design/ARCHITECTURE.md`, `design/api/openapi.yaml`, `design/research/personas-dashboards.md`, then the research report for each module as you reach it (`design/research/bill-viewer.md`, `search.md`, `editor.md`, `workflow-engine.md`, `fiscal-notes.md`, `leg-wa-gov-services.md`, `legiscan-data.md`). The twelve fiscal note templates and their schema are in `design/templates/`. Treat the design as the specification; where a research report and `ARCHITECTURE.md` disagree, `ARCHITECTURE.md` wins.

## What to build

A TypeScript monorepo (pnpm workspaces, Node 22, strict TypeScript) with:

- `apps/api`: Fastify service exposing the routes in `design/api/openapi.yaml` under `/api/v1`, with zod schemas that generate the OpenAPI document at `/api/v1/openapi.json`. Modules: identity, bills (including the ingest worker), search, notes, templates, workflow, notifications, reference, admin. Each module owns its tables and talks to the others only through the REST API or the in-process event bus backed by the `outbox` table.
- `apps/web`: React 19 + Vite + React Router app with the routes in `ARCHITECTURE.md` (search box on every page, drafter and reviewer dashboards, bill page with the approved-note panel for end users, the two-pane workspace, document versions, search results, inbox, admin).
- `packages/billref`: the pure bill-reference parser from `design/research/search.md` §2, with the 63-case fixture table as tests. Canonical version code is `I` for introduced; the file-suffix function maps `I` to an empty suffix.
- `packages/bill-document`: Bill Document and Amendment Document JSON Schemas and types (`bill-viewer.md` §3), the parser from lawfilesext XML (`leg-wa-gov-services.md` "XML schema" section: `BillSection[@type][@action]`, `SectionCite`, `TextRun[@amendingStyle]`, inline subsection markers), an HTM fallback parser, section identity, `textHash`, and the two-pass reading-text diff ported from `uscode-redesign/frontend/src/lib/diffdoc.ts` (local checkout at `../uscode-redesign`).
- `packages/note-schema`: Tiptap 3 extensions for the limited and full schemas (`editor.md` §3), the template loader that turns a `design/templates/*.html` fragment plus a token context into ProseMirror JSON (honoring `data-slot`, `data-role`, `data-computed`, `data-repeat`, `data-locked`, `data-picklist`, `{{token}}`), the estimate-data extractor, and the validator that enforces the reconciliation rules in `fiscal-notes.md` §8 (biennium columns are sums of fiscal years, FTE biennium columns are averages, Part I totals equal III.A totals, III.B FTE totals equal the Part I FTE row).
- `packages/workflow-machine`: the XState v5 machine from `workflow-engine.md` §3 with role guards, exported for the server (pure `transition()`) and the client (`can()` for button state).
- `packages/api-client`: generated from the OpenAPI document.
- `docker-compose.yml`: Postgres 16, OpenSearch 3.7 single node (1 GB heap, security plugin disabled), an SMTP sink, and a dev OIDC issuer with one test user per role plus one user who is both drafter and reviewer.
- A CLI (`wa-leg`) with `ingest legiscan <dir>`, `ingest refresh`, `search init`, `search load`, `db migrate`, `db seed`.

Stack constraints: Postgres via Drizzle ORM with SQL migrations; OpenSearch via `@opensearch-project/opensearch` behind the `SearchBackend` interface with a Postgres full-text implementation as the fallback; Tiptap 3 with `@tiptap/extension-table` and `@tiptap/extension-mathematics`, KaTeX for rendering, MathLive in a popover for editing; `docx` for DOCX export, Playwright Chromium for PDF; `diff-match-patch` for diffs; `openid-client` for OIDC; pino logging with request ids. Pin exact versions. Only MIT, BSD, Apache, or MPL components in the shipped bundle; generate `THIRD_PARTY.md` in CI. No AI components in the core.

## Data

The Legiscan dataset for the 2025-26 session is the zip in the repo root (git-ignored). Unzip it to `data/` and load it with `wa-leg ingest legiscan data/WA/2025-2026_Regular_Session`. For each bill text, derive the version code from the `state_link` file name, fetch the XML by substituting `/Xml/` for `/Pdf/` and `.xml` for `.pdf`, cache the fetched file on disk keyed by URL and ETag, and parse it into a Bill Document. Fetch amendments the same way. Keep the fiscal note supplement links as prior fiscal notes on the bill. Derive hearings from `calendar[]`. Do not fetch more than needed for tests during development: a `--limit` flag and a fixture corpus of 20 bills (checked into `packages/bill-document/fixtures`, covering amendatory, new chapter, repealer, effective-date, emergency, part-numbered, and a table-bearing tax bill) are required before the full load.

## Build order and acceptance

Work through the milestones in `ARCHITECTURE.md` "Build order". Each milestone is done when its tests pass and it can be demonstrated end to end:

1. Foundation: `pnpm dev` brings up API and web; `/api/v1/me` returns the dev principal after login; `can()` unit tests cover the permission matrix in `personas-dashboards.md`; CI runs lint, typecheck, unit tests, and Playwright.
2. Bills: `billref` fixtures pass; the parser round-trips the fixture corpus with hash-checked expected JSON; `GET /bills/2025-26/HB2402/versions/S` returns a Bill Document; `GET .../diff?from=I&to=S` returns a VersionDiff and the service and client diff agree on fixtures.
3. Bill viewer: `/bills/2025-26/HB2402/S#sec-2` opens the substitute at section 2 with outline, sticky section bar, version switcher, RCW-affected list, printed-bill marks, keyboard map, and a working `onCite`; compare view renders the redline; axe passes at four widths in light and dark.
4. Search: typing `shb 2402` in the search box redirects to `/bills/2025-26/HB2402/S`; `phthalates` returns section hits with highlights and facets; a reviewer's search never returns another drafter's unsubmitted draft (test).
5. Notes and editor: create a note on SHB 2402 from the `sales-use-tax-exemption` template; slots are highlighted until filled and Tab moves between them; the estimate table auto-sums and formats currency; a citation inserted from the bill viewer links to `#sec-2`; a formula is entered with MathLive and rendered with KaTeX; autosave uses `If-Match` and shows the conflict banner on a 412; the version list shows a redline between two saves; comments anchor to ranges and survive edits.
6. Workflow: the drafter submits, the reviewer claims, requests changes, the drafter resubmits, the reviewer approves; a two-step Executive Review chain notifies each step; dashboards show the right rows with the role vocabulary; a hearing four hours away puts the note at the top with an overdue label; the transition log is complete; a new bill version supersedes the open revision and offers a cloned revision.
7. Publish and export: a viewer opens the bill page and sees the approved note beside the bill; DOCX, PDF, and HTML exports render the templates faithfully including tables and math; the FNS XML placeholder emits slot values and table cells; `GET /admin/audit` lists every transition, save, and export.
8. Hardening: axe clean on every route; a k6 or autocannon run at 3x the expected session load with P95 under the targets; `THIRD_PARTY.md`; as-built architecture notes in `docs/`; a scripted demo covering the three personas.

## Working rules

- Keep each module behind its API. A module never imports another module's tables or services directly; it calls the HTTP route or subscribes to an event.
- Every state change writes an audit row and, where the design says so, an outbox event in the same transaction.
- Every interactive element responds to a single click and is reachable by keyboard (TR-106, WCAG 2.2 AA). Never convey state by colour alone.
- Version codes, bill keys, and section ids are the ones defined in `ARCHITECTURE.md`; do not invent parallel identifiers.
- Fiscal note documents are ProseMirror JSON; HTML and estimate data are derived on save. Templates are HTML fragments; they are parsed once at insertion.
- Where the design marks something unverified (FNS XML schema, the 72-hour clock start, EBB), isolate it behind an interface and a config value and note it in `docs/OPEN-ITEMS.md`.
- Write tests alongside code: unit tests for packages, route tests for the API, Playwright for the web app. Do not report a milestone as done until its acceptance checks pass.
- Commit at the end of each milestone with a message that names the milestone. Do not commit `data/`, `RFP-docs/`, or the zip.

Start with milestone 1. Before writing code for it, print a short plan listing the files you will create; then build it.
