# Architecture as built

The proof of concept follows `design/ARCHITECTURE.md`. This note records what exists, where it lives, and
where the build departs from the design.

## Runtime

| Piece | Implementation |
|---|---|
| API | Fastify 5 with zod schemas; OpenAPI at `/api/v1/openapi.json`; `packages/api-client` generated from it |
| Web | React 19, Vite, React Router; Tiptap 3 editor; KaTeX and MathLive |
| Database | Postgres 16; SQL migrations in `apps/api/drizzle`, applied by `wa-leg db migrate` (advisory lock, `schema_migrations`) |
| Search | OpenSearch 3 (six indices behind `waleg_search_all`) or a Postgres fallback (`SEARCH_BACKEND`) |
| Identity | OIDC with PKCE through `openid-client`; the dev issuer in `apps/dev-oidc`; HS256 session cookie or bearer |
| Events | `outbox` table written in the same transaction as each change; an in-process relay delivers to named consumers, idempotent per `(consumer, event_id)` |
| Mail | nodemailer to the mailpit sink in development; `NOTIFY_EMAIL=false` disables it |
| PDF | `playwright-core` Chromium in the API process (`PDF_ENABLED`) |

## Modules

Each module owns its tables and talks to the others through the HTTP routes (`internalCall` injects a request
with a system token) or the event bus.

| Module | Tables | Routes | Consumes | Emits |
|---|---|---|---|---|
| identity | `users` | `/me`, `/users`, `/auth/*` | | |
| bills | `bills`, `bill_versions`, `amendments`, `hearings`, `prior_fiscal_notes`, `ingest_runs` | `/bills/*`, `/hearings`, `/admin/ingest/*` | | `bill.created`, `bill.version_added`, `bill.amendment_added`, `bill.status_changed`, `hearing.*` |
| search | `search_docs` (fallback) | `/search`, `/search/suggest`, `/search/reindex` | bill and note events | |
| notes | `notes`, `note_revisions`, `note_documents`, `note_comments`, `note_comment_messages`, `note_change_requests`, `note_change_request_items`, `note_locks`, `note_exports` | `/notes/*` (including `/notes/{id}/change-requests/*`), `/bills/{b}/{id}/notes`, `/export-jobs/*` | `bill.version_added`, `note.approved` | `note.created`, `note.revision_created`, `note.document_saved`, `fiscal_note.requested`, `note.exported` |
| templates | `templates` | `/templates/*` | | |
| reference | `reference_sets` | `/reference/*` | | |
| workflow | `workflow_instances`, `workflow_transitions`, `workflow_assignments`, `workflow_deadlines` | `/notes/{id}/workflow`, `/notes/{id}/transitions`, `/notes/{id}/assign`, `/notes/{id}/exec-chain`, `/assignments`, `/workflow/*` | `fiscal_note.requested`, `note.revision_created`, `note.document_saved`, `hearing.*` | `note.transitioned`, `note.assigned`, `note.due_soon`, `note.overdue`, `note.approved`, `note.superseded` |
| notifications | `notifications` | `/notifications/*` | workflow events, bill events | |
| admin | `audit_log` (written by every module) | `/admin/audit`, `/health` | | |

## Packages

| Package | Contents |
|---|---|
| `billref` | Bill reference parser and labels; version codes (`I` for introduced) |
| `bill-document` | Bill Document schema, XML and HTM parsers, section identity, two-pass diff, section subjects (`sectionSubject`: RCW caption or a paraphrase of a new section's first sentence), JSON schemas, fixture corpus |
| `note-schema` | Tiptap extensions for both modes, template loader, computed-cell evaluator, estimate extractor, validator, diff, HTML |
| `workflow-machine` | XState v5 machine, vocabularies, pure `step` and `can` |
| `api-client` | `openapi-fetch` client typed from the generated schema |

## Departures from the design

- Exports run synchronously; `/export-jobs/{id}` reports the stored export rather than a queued job.
- DOCX formulas cover a LaTeX subset (no LGPL converter in the bundle).
- Search visibility of unsubmitted drafts follows `search.md` (participants and admins only) rather than the
  broader `can()` read rule used when a note is opened by link.
- `SUBMIT_FOR_REVIEW` notifies every reviewer and manager; routing by division is not modelled.
- The FNS XML mapping is a placeholder behind `FnsXmlMapper`.
- The drafter's first document save sends `START`; the button remains for a drafter who has not typed yet.
- Short in-process caches protect the read paths under burst: bill facts and user names for 60 s, work queues for
  5 s per caller (single-flight, invalidated by any workflow write), search results for 10 s per caller and
  query. Facets run as a size-0 OpenSearch request so its request cache applies.
- Autosaves reindex only the note document; the bill document is reindexed when a note's status or assignees
  change.
- Change requests are a notes-module object rather than part of the workflow snapshot. The workflow module
  records one after `REQUEST_CHANGES` or `EXEC_RETURN` through `POST /notes/{id}/change-requests` (items from
  the comment's bullet lines and the open comment threads) and refuses `SUBMIT_FOR_REVIEW` while a request
  has open items.
- One status vocabulary is shown to every role. The machine still exposes `drafterStatus` and
  `reviewerStatus`, and `GET /assignments` still filters by them, but the web app labels rows from the state.
- `wa-leg demo seed` (`apps/api/src/db/demo.ts`) builds the demo scenario through the HTTP API as the test
  users; `docs/DEMO.md` describes the result.

Open questions the design marked unverified are listed in `OPEN-ITEMS.md`.

## Checks

`pnpm lint`, `pnpm typecheck`, `pnpm test` (unit and route tests against `wa_leg_test`), `pnpm test:e2e`
(Playwright with axe at four widths and two themes on every route), `pnpm third-party` (license allowlist),
`pnpm load` (autocannon; results in `LOAD-TEST.md`).
