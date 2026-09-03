# Fiscal Note Workbench: architecture

A proof-of-concept tool for the Washington Department of Revenue (DOR) that covers the core of RFP DOR-RFP-2026-02: reading a bill, drafting a fiscal note against a specific bill version, reviewing and approving it, and publishing it to end users. It leaves out the tracking-system surround (packages, data requests, bill descriptions, legislative implementation, reporting, legacy migration), which are listed as adapter interfaces in `research/rfp-summary.md`.

Research behind each decision is in `research/`. This document fixes the decisions and the contracts between modules.

## Decisions

| Area | Decision | Source |
|---|---|---|
| Bill data | Legiscan JSON is the index. Bill text and amendments are fetched from `lawfilesext.leg.wa.gov` in XML (namespace `http://leg.wa.gov/2012/document`), HTM as fallback, PDF as last resort. LSC web services are the production freshness source behind an adapter. | `research/leg-wa-gov-services.md`, `research/legiscan-data.md` |
| Bill identity | `BillKey = WA:{biennium}:{type}{number}` (`WA:2025-26:HB2402`). Version code is the lawfilesext suffix with `I` for introduced: `I, S, S2, S3, E, E2, S.E, S2.E, S.E2, PL, S.PL, SL, S.SL`. Display labels (HB, SHB, 2SHB, ESHB, E2SHB, 2ESHB) are derived. Amendment id is the lawfilesext name (`6137 AMS CORA S4812.1`). | `research/search.md` §2 (which uses `""` for introduced; `I` is the canonical form in URLs and APIs, `""` only when building file names) |
| Bill viewer | React component fed by Bill Document JSON. Ported from uscode-redesign: two-pass reading-text diff, redline markup, sticky-height token, provision ladder, keyboard map, stable ids as anchors. | `research/bill-viewer.md` |
| Search | OpenSearch 3.x with a `SearchBackend` interface and a Postgres full-text fallback. A pure `billref` parser package shared by the search box, router, and loader. | `research/search.md` |
| Editor | Tiptap 3 on ProseMirror. Two schemas (limited for fiscal notes, full for estimates). KaTeX render, MathLive edit. ProseMirror JSON is the stored form; HTML and structured estimate data are derived. Comments and version diffs are open-source implementations, not Tiptap Cloud. | `research/editor.md` |
| Templates | Twelve HTML fragments with `data-slot`, `data-role`, `data-computed`, `data-repeat`, `data-locked`, `{{token}}` markup and a manifest. | `templates/`, `research/fiscal-notes.md` |
| Workflow | XState v5 machine evaluated server-side with the pure `transition()` function, snapshot in Postgres, same machine imported by the client for button state. Deadlines are rows fired by a poller. | `research/workflow-engine.md` |
| Export | DOCX via the `docx` npm mapper from ProseMirror JSON; PDF via Playwright Chromium; HTML directly; FNS XML via an isolated placeholder mapping (the FNS schema is not public). | `research/editor.md` §6, `research/fiscal-notes.md` §6 |
| Identity | OIDC (Entra ID in production, a local dev issuer in development). Roles come from token claims mapped in configuration. No local credential store. | TR-303, TR-309 |
| Stack | TypeScript monorepo: Fastify API, React + Vite web app, Postgres 16, OpenSearch 3, Node 22 LTS. One language so the parser, workflow machine, editor schema, and export mapper are written once and run on both server and client. | This document |

The Python alternative (FastAPI, python-statemachine, python-docx, a Python port of `billref`) is viable and is described in each research report. It costs three ports of shared logic and is not the default.

## Module map

```
                        ┌──────────────────────────────────────────────┐
                        │                 apps/web (React)              │
                        │  shell · search box · dashboards · workspace  │
                        │  <BillViewer>  <NoteEditor>  <ReviewPanel>    │
                        └───────┬───────────┬───────────┬──────────────┘
                                │ REST /api/v1 (OpenAPI) │
┌───────────────────────────────┴───────────┴───────────┴───────────────────────┐
│                               apps/api (Fastify)                              │
│  identity ── bills ── search ── notes ── templates ── workflow ── notifications│
│      │          │        │        │          │           │            │        │
│      │   in-process event bus backed by outbox table (later: broker)  │        │
└──────┼──────────┼────────┼────────┼──────────┼───────────┼────────────┼────────┘
       │          │        │        │          │           │            │
   OIDC IdP   Postgres  OpenSearch  Postgres  templates/  Postgres    SMTP / Graph
              + object                        (files)     (poller)
              store
       ▲
       │ ingest worker: Legiscan JSON → lawfilesext XML → Bill Document JSON → Postgres + index
```

Shared packages (`packages/`):

| Package | Contents | Used by |
|---|---|---|
| `billref` | Reference parser and formatter: `parse(input) → BillRef | AmendmentRef | RcwRef | SessionLawRef | FnPackageRef | null`, `label(ref)`, `fileSuffix(versionCode)`, `urlFor(ref)`. No I/O. 63-case fixture file. | web search box, router, API, ingest |
| `bill-document` | JSON Schema and TypeScript types for Bill Document and Amendment Document; the XML parser (`parseBillXml`), HTM fallback parser, section identity, `textHash`, the two-pass diff (`diffdoc`). | ingest, bills service, bill viewer |
| `note-schema` | Tiptap extensions for both modes: `noteSection`, `estimateTable`, `assumptionList`, `billCitation`, `mathInline/Block`, `slot`, `comment` mark; template loader (HTML fragment + context → ProseMirror JSON); estimate-data extractor and validator (totals reconcile); HTML generation. | web editor, notes service, export |
| `workflow-machine` | XState machine, role guards, event types, state → role-vocabulary mapping. | workflow service, web |
| `api-client` | Generated from the OpenAPI document. | web |

## Contracts between modules

Every module talks to the others only through the REST API or the event bus. Tables are private to the module that owns them.

### Identity

`Principal = { userId, displayName, email, roles: Role[], divisions: string[] }`, resolved per request from the OIDC session. `Role = drafter | reviewer | approver | manager | viewer | template_editor | admin`. The dev issuer serves a fixed set of test users, one per role, plus one user holding drafter and reviewer.

Authorization is a single function `can(principal, action, resource)` in the API, called by route handlers. Resource state comes from the workflow snapshot for notes and from the sensitivity flag for confidential notes. `research/personas-dashboards.md` has the matrix.

### Bills

Owns: `bills`, `bill_versions` (Bill Document JSON, source hashes), `amendments` (Amendment Document JSON), `hearings`, `prior_fiscal_notes` (OFM package links), `ingest_runs`.

Endpoints (`research/bill-viewer.md` §5): `GET /bills/{biennium}/{id}`, `GET /bills/{biennium}/{id}/versions/{code}`, `GET .../versions/{code}/sections/{sectionId}`, `GET .../diff?from&to&mode`, `GET .../amendments`, `GET .../amendments/{amendmentId}`, `GET .../hearings`, `GET /bills/resolve?ref=`.

Emits: `bill.created`, `bill.version_added {billKey, versionCode}`, `bill.amendment_added {billKey, amendmentId, baseVersionCode}`, `hearing.scheduled` / `hearing.rescheduled` / `hearing.cancelled {billKey, versionCode?, hearingAt, committee}`, `bill.status_changed`.

Ingest is a worker inside this module: `wa-leg ingest legiscan <dir>` loads the dataset; `wa-leg ingest refresh` polls the LSC adapter (5-minute cadence during session) and re-fetches changed documents by `Last-Modified`/`ETag`. The Bill Document parser is the only code that knows the WA XML vocabulary. Section kinds map from XML `BillSection[@type][@action]`: `new` (no action), `addsect`, `addchap`, `amend`, `remd`, `amenduncod`, `repeal`, `effdate`, `emerg`, `expdate`. Cross-version section identity: `rcw:{cite}` for amendatory and repeal sections, `new:{chapter}:{ordinal}` for added sections, `kind:{kind}` for effective-date, emergency, expiration, and severability sections, otherwise a hash of the first 200 characters.

### Search

Owns: OpenSearch indices `bills`, `bill_sections`, `amendments`, `fiscal_notes`, `rcw_sections`, `templates` under the `search_all` alias, or the `search_docs` Postgres table in fallback mode.

Endpoints (`research/search.md` §6): `GET /search`, `GET /search/suggest`, `POST /search/reindex`.

Consumes: `bill.*`, `note.transitioned`, `note.document_saved` (re-index the note with its visibility fields). Permission filters are applied server-side from the principal; a client-supplied permission field is a 400.

### Notes

Owns: `notes` (one per bill and request), `note_revisions` (one per bill version or amendment the note is written against; the unit the workflow tracks), `note_documents` (autosave head plus named snapshots, `version` integer as ETag), `note_comments`, `note_exports`, `audit_log`.

Endpoints (`research/editor.md` §8): `GET/PUT /notes/{id}/document` with `If-Match`, `GET /notes/{id}/versions`, `POST .../versions`, `POST .../versions/{v}/restore`, `GET .../diff`, `POST/DELETE .../lock`, comments CRUD, `POST .../export?format=`, `GET /export-jobs/{jobId}`; plus `POST /notes` (create from a bill version and optional template or prior note), `GET /notes/{id}`, `POST /notes/{id}/revisions` (new revision for a new bill version, cloning the document), `GET /bills/{biennium}/{id}/notes` (revisions per version, filtered by visibility).

`{id}` on document, comment, workflow, and export routes is a note revision id.

Emits: `note.created`, `note.revision_created`, `note.document_saved {noteRevisionId, version}`, `note.exported`.

Consumes: `bill.version_added` (offers a new revision to the drafter; automatic creation is configurable), `note.approved` (freezes the head document as the approved snapshot and marks it public unless confidential).

### Templates

Owns: template files under `templates/` loaded at startup into `templates` table rows (id, name, kind, mode, tags, slots, tokens, html, version, etag). Editing templates in the UI is a `template_editor` feature that writes new rows; the files remain the seed.

Endpoints: `GET /templates?mode&kind&taxType&impactType&q`, `GET /templates/{id}`, `GET /templates/{id}/preview?noteId=`, `PUT /templates/{id}` (template_editor).

Token context (`TemplateContext`) is assembled by the notes module from the bill version, the request, the principal, and per-session reference data (fiscal-year labels, biennia, forecast vintage, salary table, account codes). Reference data lives in `reference/` as JSON and is exposed at `GET /reference/{set}`.

### Workflow

Owns: `workflow_instances` (snapshot JSONB, flattened state, version), `workflow_transitions` (append-only), `assignments`, `deadlines`, `outbox`.

Endpoints (`research/workflow-engine.md` §6): `GET /notes/{id}/workflow`, `POST /notes/{id}/transitions`, `GET /notes/{id}/transitions`, `POST /notes/{id}/assign`, `PUT /notes/{id}/exec-chain`, `POST /notes/{id}/workflow/duplicate`, `GET /assignments`, `GET /workflow/summary`.

States: `todo`, `in_progress`, `review.pending`, `review.active`, `changes_requested`, `exec_review.pending`, `exec_review.active`, `approved`, `cancelled`, `superseded`. Role vocabularies: drafter sees to-do, in-progress, ready-for-review, address-review, approved; reviewer sees pending, in-review, changes-requested, approved. Executive Review is an ordered chain in the instance context.

Deadlines per instance: `statutory_72h` (request time + 72 clock hours), `hearing_minus_4h` (recomputed on hearing events), `role_due` (set by the assigner). A 60-second poller with `SKIP LOCKED` emits `note.due_soon` at 24 hours and 4 hours and `note.overdue`.

Consumes: `fiscal_note.requested`, `bill.version_added` (sends `SUPERSEDE` to the open instance and creates the new one when the notes module creates a revision), `hearing.*`.

Emits: `note.transitioned`, `note.assigned`, `note.due_soon`, `note.overdue`, `note.approved`, `note.superseded`.

### Notifications

Owns: `notifications` (in-app inbox), delivery adapters (console and SMTP in development, Microsoft Graph in production).

Endpoints: `GET /notifications?unread`, `POST /notifications/{id}/read`.

Consumes: `note.assigned`, `note.transitioned` (submitted, changes requested, approved), `note.due_soon`, `note.overdue`, `bill.version_added` and `bill.amendment_added` for bills with open notes, `hearing.*`.

### Web app

Routes:

| Route | Persona | Content |
|---|---|---|
| `/` | all | Search box; role-appropriate dashboard |
| `/dashboard/drafter`, `/dashboard/reviewer` | drafter, reviewer | Queues from `GET /assignments` and `GET /workflow/summary` |
| `/bills/{biennium}/{id}` → `/bills/{biennium}/{id}/{code}` | all | Bill page: viewer plus the approved note panel |
| `/bills/{biennium}/{id}/compare?from&to&at` | all | Version compare |
| `/notes/{revisionId}` | drafter, reviewer | Workspace: bill viewer left, editor or review view right, workflow bar on top |
| `/notes/{revisionId}/versions` | drafter, reviewer | Document version list and diff |
| `/search?q=` | all | Results with facets |
| `/inbox` | all | Notifications |
| `/admin/templates`, `/admin/ingest` | template_editor, admin | |

The bill viewer emits `CiteEvent`; the workspace converts it into a `billCitation` node insert through `NoteEditorHandle.insertCitation`. The shared `BillCitation` type is `{ billKey, versionCode, versionLabel, sectionId, blockId?, label?, citation, href, text?, amendmentId? }`, defined in `bill-document` and used by both components.

## Event catalog

| Event | Producer | Payload | Consumers |
|---|---|---|---|
| `bill.created` | bills | `{billKey}` | search |
| `bill.version_added` | bills | `{billKey, versionCode, label, sourceHash}` | search, notes, workflow, notifications |
| `bill.amendment_added` | bills | `{billKey, amendmentId, baseVersionCode, kind}` | search, notifications |
| `bill.status_changed` | bills | `{billKey, status, action, date}` | search |
| `hearing.scheduled` / `hearing.rescheduled` / `hearing.cancelled` | bills | `{billKey, versionCode?, hearingAt, committee, chamber}` | workflow, notifications |
| `fiscal_note.requested` | notes | `{noteRevisionId, billKey, versionCode, requestedAt, hearingAt?, requestedBy}` | workflow |
| `note.created` / `note.revision_created` | notes | `{noteId, noteRevisionId, billKey, versionCode, previousRevisionId?}` | workflow, search |
| `note.document_saved` | notes | `{noteRevisionId, version, actorId}` | search |
| `note.transitioned` | workflow | `{instanceId, noteRevisionId, seq, event, from, to, actorId, occurredAt}` | notes, search, notifications, dashboards |
| `note.assigned` | workflow | `{instanceId, noteRevisionId, role, assigneeId, previousAssigneeId?, dueAt?, assignedBy}` | notifications |
| `note.due_soon` / `note.overdue` | workflow | `{instanceId, noteRevisionId, kind, dueAt, assigneeIds[], managerIds?[]}` | notifications |
| `note.approved` | workflow | `{instanceId, noteRevisionId, billKey, versionCode, approvedAt}` | notes, search, notifications |
| `note.superseded` | workflow | `{instanceId, noteRevisionId, newNoteRevisionId}` | notifications, search |
| `note.exported` | notes | `{noteRevisionId, format, actorId}` | audit |

Events are rows in `outbox` written in the same transaction as the state change; a relay publishes them to the in-process bus. Consumers are idempotent on `(event_id)`.

## Data model summary

```
bills(bill_key pk, biennium, chamber, type, number, title, status, status_date, current_version_code,
      legiscan_bill_id, change_hash, sponsors jsonb, committee jsonb, history jsonb, calendar jsonb, sasts jsonb)
bill_versions(bill_key, version_code, seq, label, document jsonb, source_url_xml, source_url_pdf,
      source_hash, fetched_at, parser_version, pk(bill_key, version_code))
amendments(amendment_id pk, bill_key, base_version_code, chamber, sponsor, kind, adopted, document jsonb, source_hash)
hearings(id pk, bill_key, committee, chamber, hearing_at timestamptz, kind, source, revised_at)
prior_fiscal_notes(id pk, bill_key, version_label, package_id, label, url, published_at)

notes(note_id pk, bill_key, request_id, request_source, requested_at, requested_by, confidential bool, kind note|estimate)
note_revisions(note_revision_id pk, note_id, version_code, amendment_id?, previous_revision_id?, created_at, approved_document_version?)
note_documents(note_revision_id, version, mode, doc_json jsonb, doc_html text, estimate_data jsonb, label?, updated_by, updated_at, pk(note_revision_id, version))
note_comments(id pk, note_revision_id, anchor_text, status, created_by, created_at) ; note_comment_messages(...)
note_locks(note_revision_id pk, holder, expires_at)
note_exports(id pk, note_revision_id, format, document_version, status, url, created_by, created_at)

templates(id pk, version, name, kind, mode, description, tags jsonb, slots jsonb, tokens jsonb, html text, etag)
reference_sets(name pk, session, data jsonb)

workflow_instances(instance_id pk, note_revision_id unique, machine_version, snapshot jsonb, state, drafter_id, reviewer_id,
      exec_chain jsonb, exec_index, priority, version int, updated_at)
workflow_transitions(seq pk, instance_id, event, from_state, to_state, actor_id, comment, payload jsonb, occurred_at)
assignments(id pk, instance_id, role, user_id, position?, due_at?, assigned_by, assigned_at, ended_at?)
deadlines(id pk, instance_id, kind, due_at, warn_at, fired_warn_at?, fired_due_at?, cancelled_at?)
outbox(event_id pk, type, payload jsonb, created_at, published_at?)

users(user_id pk, subject, display_name, email, roles text[], divisions text[], last_seen_at)
notifications(id pk, user_id, type, payload jsonb, created_at, read_at?)
audit_log(id pk, actor_id, action, object_type, object_id, before jsonb, after jsonb, request_id, at)
search_docs(...)  -- Postgres fallback only
```

## Deployment

Development: `docker compose up` starts Postgres 16, OpenSearch 3.7 (1 GB heap, security plugin disabled), a MailHog-style SMTP sink, and the dev OIDC issuer. `pnpm dev` runs the API, the web app, and the poller. `wa-leg ingest legiscan ./data/WA/2025-2026_Regular_Session` loads the session.

Production shape (Appendix F answer, DOR-hosted in AWS): ECS Fargate services for the API, the web static bundle behind CloudFront, the ingest and deadline workers as scheduled tasks; RDS Postgres Multi-AZ; Amazon OpenSearch Service; S3 for exports and cached source documents; Entra ID via OIDC; AWS WAF and Shield Standard; CloudWatch logs and alarms; Terraform for all of it. RPO 4 hours and RTO 24 hours are met by RDS automated backups and a documented restore runbook. Nothing in the application depends on an AWS-only service beyond storage and hosting, which satisfies TR-105.

## Non-functional targets

| Item | Target | How |
|---|---|---|
| Concurrency | 60+ simultaneous users, 3x burst | Stateless API, connection pool, indexed queries, OpenSearch for search |
| Latency | P95 under 500 ms for reads, 1 s for saves | Bill Documents cached with immutable headers; autosave debounced |
| Uptime | 99.9% during session | Multi-AZ, health checks, no single-process state |
| Accessibility | WCAG 2.2 AA | axe in Playwright at four widths and two themes; manual NVDA and VoiceOver passes on the editor, estimate table, and math popover |
| Audit | Every transition, save, export, permission denial | `audit_log` plus `workflow_transitions` |
| Licensing | Permissive only in the shipped bundle | MIT/BSD/Apache components; pandoc and LibreOffice as optional subprocesses; `THIRD_PARTY.md` generated in CI |

## Build order

Each milestone ends with a demoable slice and its tests.

1. **Foundation**: monorepo, Docker Compose, Postgres migrations, OIDC dev issuer, principal and `can()`, OpenAPI generation, CI.
2. **Bills**: `billref` package with fixtures; Bill Document parser from lawfilesext XML with a 20-bill fixture corpus; Legiscan loader; bills endpoints; diff endpoint.
3. **Bill viewer**: `<BillViewer>`, `<BillOutline>`, `<VersionCompare>` on a bill page with the two-pane shell and a stub right pane that lists emitted citations.
4. **Search**: OpenSearch indices and loader; `/search`, `/suggest`, `/resolve`; search box with direct-hit redirect and results page.
5. **Notes and editor**: notes tables; `note-schema` package; `<NoteEditor>` in limited mode with estimate tables, slots, citations, math, comments; template panel over the twelve templates; autosave with `If-Match`; version list and diff.
6. **Workflow**: machine, instances, transitions, assignments, deadlines, poller; workflow bar in the workspace; drafter and reviewer dashboards; notifications inbox.
7. **Publish and export**: approved-note panel on the bill page for end users; DOCX, PDF, HTML export; placeholder FNS XML; audit log views.
8. **Hardening**: accessibility passes, load test at 3x, `THIRD_PARTY.md`, as-built docs, demo script for the RFP demonstration.

Deferred after the POC: page-and-line amendment overlay, `effect` diff mode, full-mode editor for estimates, Yjs collaboration, LSC live polling in production, FNS transmission, SharePoint storage, packages, reporting.
