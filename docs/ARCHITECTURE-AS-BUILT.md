# Architecture as built

The 0.2 system implements `SIMPLIFY-0.2.md` section 2 on the foundation laid out in `design/ARCHITECTURE.md`.
This note records what exists, where it lives, and where the build departs from those documents.

## Runtime

| Piece | Implementation |
|---|---|
| API | Fastify 5 with zod schemas; OpenAPI at `/api/v1/openapi.json`; `packages/api-client` generated from it |
| Web | React 19, Vite, React Router; Tiptap 3 editor; KaTeX for rendering |
| Database | Postgres 16; SQL migrations `0001` to `0008` in `apps/api/drizzle`, applied by `wa-leg db migrate` (advisory lock, `schema_migrations`) |
| Search | OpenSearch 3 (one index per document type behind a `waleg_` prefix) or a Postgres fallback (`SEARCH_BACKEND`) |
| Identity | OIDC with PKCE through `openid-client`; the dev issuer in `apps/dev-oidc`; HS256 session cookie or bearer |
| Events | `outbox` table written in the same transaction as each change; an in-process relay delivers to named consumers, idempotent per `(consumer, event_id)` |
| PDF | `playwright-core` Chromium in the API process (`PDF_ENABLED`) |

## Modules

Each module owns its tables and talks to the others through the HTTP routes (`internalCall` injects a request
with a system token) or the event bus.

| Module | Tables | Routes | Consumes | Emits |
|---|---|---|---|---|
| identity | `users` | `/me`, `/users?role=`, `/auth/*` | | |
| bills | `bills`, `bill_versions`, `amendments`, `hearings`, `prior_fiscal_notes`, `ingest_runs` | `/bills/*`, `/hearings` | | `bill.created`, `bill.version_added`, `bill.amendment_added`, `bill.status_changed`, `hearing.*` |
| search | `search_docs` (fallback) | `/search`, `/search/suggest`, `/search/reindex` | bill and hearing events | |
| notes | `notes`, `note_revisions`, `note_documents`, `note_comments`, `note_comment_messages`, `note_change_requests`, `note_exports` | `/notes`, `/notes/{id}`, `/notes/{id}/document`, `/notes/{id}/versions[/{v}]`, `/notes/{id}/comments/*`, `/notes/{id}/export`, `/bills/{b}/{id}/notes` | bill and hearing events (bill facts cache) | `note.created`, `note.document_saved`, `note.exported` |
| workflow | `workflow_instances`, `workflow_transitions` | `/notes/{id}/workflow`, `/notes/{id}/transitions` | | `note.transitioned`, `note.approved`, `note.published` |
| published | reads `note_revisions` | `/published` | | |
| templates | `templates` | `/templates`, `/templates/{id}` | | |
| reference | `reference_sets` | `/reference/*` | | |
| health | | `/health` | | |

Ingest is the CLI (`wa-leg ingest legiscan`, `wa-leg ingest refresh`); it has no routes. `audit_log` is written by
every module through `writeAudit()`; no route reads it.

## Packages

| Package | Contents |
|---|---|
| `billref` | Bill reference parser and labels; version codes (`I` for introduced) |
| `bill-document` | Bill Document schema, XML and HTM parsers, section identity, two-pass diff, section subjects (`sectionSubject`: RCW caption or a paraphrase of a new section's first sentence), JSON schemas, fixture corpus |
| `note-schema` | Tiptap extensions for both modes, `BillCitation` with `sameTarget()`, template loader, computed-cell evaluator, estimate extractor, validator, diff, HTML |
| `workflow-machine` | Transition table over five states and four events: `transition()`, `availableEvents()`, `STATE_LABELS`, `STATE_HINTS`, `EVENT_LABELS` |
| `api-client` | `openapi-fetch` client typed from the generated schema |

## Workflow

`packages/workflow-machine/src/table.ts` holds five rules: `draft --SUBMIT--> in_review`,
`changes_requested --SUBMIT--> in_review`, `in_review --REQUEST_CHANGES--> changes_requested` (message
required), `in_review --APPROVE--> approved`, `approved --PUBLISH--> published`. The drafter is the note's
`drafterId`; a reviewer is any user with the reviewer role who is not the drafter. The first review action
sets `reviewerId`. The document is editable in `draft` and `changes_requested`.

`APPROVE` freezes the head document version as `approved_version`. `PUBLISH` writes `published_at`,
`published_by` and `published_version` on the revision, records an audit row and emits `note.published`.
`REQUEST_CHANGES` writes a `note_change_requests` row; `SUBMIT` from `changes_requested` resolves it with the
submit message as `resolution`.

## Departures from the design

- Exports run synchronously and are stored under `EXPORT_DIR` with a `note_exports` row; there is no job
  object.
- The FNS XML mapping uses provisional element names behind `FnsXmlMapper`. `strict=true` on the export refuses (422) while
  required slots are empty; the default renders the empty slots.
- `templateId` is required on `POST /notes`.
- `GET /notes/{id}/versions` (the list of document versions) remains beside `GET /notes/{id}/versions/{v}`.
- `context.ts` in `apps/api/src/modules/notes` remains as an internal helper (bill facts for the template
  context, cached for 60 s); it has no route.
- The two per-note flags and the request columns (`request_id`, `request_source`, `requested_at`,
  `requested_by`, `leg_contact`, `ten_year_requested`) that `SIMPLIFY-0.2.md` places on `note_revisions` lived
  on `notes`; migration `0008` drops them there. The successor-revision column lived on `workflow_instances`
  and is dropped there.
- Search indexes bills, sections, amendments, the OFM prior fiscal notes listed in the bill data
  (`fiscal_note` documents with `source: 'ofm'`) and the RCW sections a bill affects (`rcw_section`).
  Workbench notes are not indexed; `/notes` and `/published` list them.
- `GET /published` pages with `limit` (1 to 200, default 50) and an opaque `cursor`; the response is
  `{ items, nextCursor }`. `PUBLISHED-API.md` documents it.
- The change request banner counts every open comment thread on the note, not only the threads the reviewer
  opened.
- Short in-process caches protect the read paths under burst: bill facts and user names for 60 s; search
  results for 10 s per caller and query (single-flight). Facets run as a size-0 OpenSearch request so its
  request cache applies.
- Math nodes stay in the note schema so documents saved before 0.2 still render (KaTeX in the editor and
  HTML, Office Math in DOCX); the editor has no way to insert them.
- `wa-leg demo seed` (`apps/api/src/db/demo.ts`) builds the demo scenario through the HTTP API as the test
  users; `DEMO.md` describes the result.

Open questions the design marked unverified are listed in `OPEN-ITEMS.md`.

## Checks

`pnpm lint`, `pnpm typecheck`, `pnpm test` (unit and route tests against `wa_leg_test`), `pnpm test:e2e`
(Playwright: `login`, `notes`, `workflow`, `publish`, `bill-viewer`, `search`, and axe at four widths and
two themes on every route), `pnpm third-party` (license allowlist), `pnpm load` (autocannon; results in
`LOAD-TEST.md`).
