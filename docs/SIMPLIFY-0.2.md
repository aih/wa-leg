# 0.2: one path from draft to Committee

Site review of v0.1.0 and the implementation plan for 0.2. The goal of 0.2 is a single path: a fiscal
note is drafted, reviewed with a change request or an approval, and published for the Committee in
several formats. Everything outside that path is removed. `docs/SIMPLIFY-0.2-PROMPT.md` runs this plan
as multi-agent work on branches and worktrees.

## 1. Site review (v0.1.0, tag `v0.1.0`, commit `800ecd9`)

### What the core path uses today

| Step | Screen | Code |
|---|---|---|
| Find a bill | Search box, bill page | `apps/web/src/components/SearchBox.tsx`, `routes/BillPage.tsx`, `bill/BillViewer.tsx` |
| Create the note | New fiscal note form on the bill page | `notes/NewNoteForm.tsx`, `POST /notes` |
| Draft | Workspace: bill left, editor right; citations, estimate tables, slots, comments, autosave | `routes/NoteWorkspace.tsx`, `notes/NoteEditor.tsx`, `notes/editorExtension.ts`, `packages/note-schema` |
| Submit and review | Workflow bar buttons; comments panel | `notes/WorkflowBar.tsx`, `notes/CommentsPanel.tsx`, `packages/workflow-machine`, `apps/api/src/modules/workflow` |
| Request changes | Change request with items, address, reopen, close | `notes/ChangeRequestsPanel.tsx`, `/notes/{id}/change-requests/*` |
| Approve and publish | Approval freezes the head version; bill page panel; export menu | `notes/ApprovedNotePanel.tsx`, `apps/api/src/modules/notes/export/*` |

### What sits beside the core path

Ten workflow states (`todo`, `in_progress`, `review.pending`, `review.active`, `changes_requested`,
`exec_review.pending`, `exec_review.active`, `approved`, `cancelled`, `superseded`), thirteen events, an
executive review chain, a claim step, reassignment, three deadlines with bands and a poller, revisions for
new bill versions, inbox and email notifications, edit locks, save conflicts with a forced save, snapshots,
restore and a versions page with redline, itemised change requests, a templates tab and an admin templates
editor, formulas (MathLive), an audit page, an ingest page, seven roles and nine test users, two
dashboards with five sections each, a priority and a confidential flag on every note, note and estimate
kinds, and DOCX-with-comments exports.

Source size: `apps/web/src` 8,200 lines, `apps/api/src` 8,800 lines. The dashboards, inbox, admin pages,
versions page, change requests panel, template panel, math dialog and the assign and history panels in the
workflow bar account for about 2,300 lines of the web app; notifications, deadlines, locks, change request
items and the executive chain account for about 1,500 lines of the API.

### Failure points reported

**Two Cancel buttons.** The workflow machine exposes a global `CANCEL` event to anyone whose roles map to
the machine's `manager` role, which includes every reviewer (`apps/api/src/modules/identity/principal.ts`
`toActor()`). `WorkflowBar.tsx` renders every available event as a button, so a reviewer always sees a
button labelled *Cancel* in the action row. Opening *Request changes* (or any dialog) adds the dialog's own
*Cancel*. The same happens with the comments panel: the *New comment* form's *Cancel* sits under the
workflow *Cancel*. Pressing the wrong one cancels the whole note.

**Citations cannot be removed and can be duplicated.** `BillCitation` in
`packages/note-schema/src/extensions.ts` is an inline atom with no node view. It can only be removed by
selecting it and pressing Backspace or Delete, which nothing on screen says. `insertCitation()` in
`NoteEditor.tsx` inserts at the caret unconditionally, so pressing *Cite* twice inserts the same citation
twice.

### Other findings

- The guide, the landing page and the README each carry their own copy of the user list and the demo
  table; they drift.
- The reviewer can edit the document while the note is *In review*, so the drafter and reviewer can save
  over each other; the lock and the forced-save conflict banner exist to cope with that.
- Search indexes notes with a visibility rule derived from the workflow state; every state change in the
  machine has to be mirrored in `apps/api/src/modules/search/docs.ts`.
- *Approved* is the published state. There is no publication record, no Committee-facing list of published
  notes, and no API a downstream system could poll.
- The status hint is rendered twice in the workflow bar (as the pill's title and as text beside it).
- The first document save sends `START` on the drafter's behalf, so *To do* and *In progress* are the same
  thing from the drafter's point of view with two labels.

## 2. Target design

### Statuses

| Status | Meaning | Who acts | Editable by |
|---|---|---|---|
| Draft | The drafter is writing | Drafter: **Submit for review** | Drafter |
| In review | A reviewer is reading it | Reviewer: **Request changes** or **Approve** | Nobody (reviewer comments) |
| Changes requested | Back with the drafter, with the reviewer's message and the open comment threads | Drafter: **Submit for review** | Drafter |
| Approved | Frozen at the approved version | Reviewer: **Publish** | Nobody |
| Published | Available to the Committee beside the bill and on the Published page, in every export format | Nobody | Nobody |

Internal names: `draft`, `in_review`, `changes_requested`, `approved`, `published`. Events: `SUBMIT`,
`REQUEST_CHANGES` (message required), `APPROVE`, `PUBLISH`. A note is created in `draft` with a drafter.
There is no claim step, no cancel, no reopen, no revision, no executive chain, no deadline. A published note
never changes; a correction is a new note on the same bill version.

Folding *Approved* into *Published* (so **Approve** publishes) is a one-line change to the transition
table; the plan keeps them separate so the demo has a distinct publishing act.

### Roles and test users

| Role | Can | Test user |
|---|---|---|
| `drafter` | Create a note for themselves, edit their drafts, comment, submit | Dana Drafter |
| `reviewer` | Create a note and assign a drafter, comment, request changes, approve, publish | Rae Reviewer |
| `viewer` | Read published notes and their exports | Cam Committee (`dev-committee`) |
| `drafter, reviewer` | Both | Jordan Both |

`admin` stays as the system principal's role for the CLI and the seed; it has no screens. `approver`,
`manager`, `template_editor` and the other test users are removed.

### Screens

| Route | Who | Content |
|---|---|---|
| `/` | Everyone | Landing: what the tool does, the four test users, a link to the guide. Signed-in drafters and reviewers go to `/notes`; viewers go to `/published` |
| `/guide` | Everyone | The walkthrough, one section per stage of the path |
| `/notes` | Drafter, reviewer | One table of the notes the user can see, grouped by status in path order; columns bill, title, status, drafter, reviewer, updated; row opens the workspace |
| `/published` | Everyone signed in | Published notes newest first: bill, version, title, published date, PDF, DOCX, HTML, XML links |
| `/bills/:biennium/:id[/:code]`, `/compare` | Everyone | Bill viewer as today; the right pane shows *New fiscal note* (drafter, reviewer) and the published note panel |
| `/notes/:revisionId` | Participants and reviewers; viewers when published | Workspace: bill left, note right, workflow bar on top, tabs *Note* and *Comments* |
| `/search` | Everyone | Bill search as today |

Removed routes: `/dashboard/*`, `/inbox`, `/notes/:id/versions`, `/admin/*`.

### Workspace

- Workflow bar: bill link and title; status pill with its hint once; drafter; reviewer (set by the first
  review action); action buttons for the signed-in user's role and the status; **Export** menu (PDF, DOCX,
  HTML, XML); **History** toggle listing transitions with actor, time and message. Dialogs for *Request
  changes* (message required) and *Submit for review* (message optional) have one dismiss button, labelled
  **Cancel**. No workflow action is labelled Cancel.
- Change request: a banner while the status is *Changes requested*: who, when, the message, and the count of
  open comment threads with a link to the Comments tab. The drafter resolves threads, edits, and submits
  with a reply. The reply is the transition comment. The request and its reply stay in History.
- Comments: threads on selected text, reply, resolve, delete, as today. The *New comment* form's dismiss
  button is the only Cancel on screen while it is open.
- Citations: **Cite** in the bill pane inserts a citation node. A citation renders with a remove control
  (`×`, `aria-label="Remove citation Section 2 of SHB 2402"`) when the note is editable. Inserting a
  citation whose bill, version, section, block and amendment match an existing citation in the document
  selects the existing one, scrolls it into view and shows *Already cited: Section 2 of SHB 2402* instead of
  inserting.
- Editor toolbar: bold, italic, underline, superscript, subscript, lists, **Cite**, **Comment**, **Next
  slot**, undo, redo. *Formula* and *Template* are removed; the template is chosen at creation.
- Save: autosave with `If-Match` as today. A 412 shows one banner, *This note was saved elsewhere*, with one
  button, **Reload**. No lock, no forced save.

### API

| Keep | Change |
|---|---|
| `POST /notes` | Body: `billKey`, `versionCode`, `templateId`, `drafterId` (reviewer only; a drafter creates for themselves). `kind`, `priority`, `confidential`, `request` removed |
| `GET /notes`, `GET /notes/{id}`, `GET /bills/{b}/{id}/notes` | State names change; summary drops deadlines, priority, confidential, exec chain, supersededBy |
| `GET/PUT /notes/{id}/document`, `GET /notes/{id}/versions/{v}` | Unchanged (the approved version is a document version) |
| `/notes/{id}/comments/*` | Unchanged |
| `POST /notes/{id}/workflow` | Events `SUBMIT`, `REQUEST_CHANGES`, `APPROVE`, `PUBLISH`; `GET` returns `state`, `drafter`, `reviewer`, `availableEvents`, `changeRequest` (message, by, at, or null) |
| `GET /notes/{id}/transitions` | Unchanged |
| `GET /notes/{id}/export?format=` | Formats `html`, `pdf`, `docx`, `xml`; the `comments` option is removed; viewers get the published version |
| `GET /published` | New: published notes with bill, version, title, `publishedAt`, `publishedBy`, `publishedVersion`, and an `exports` map of the four URLs. Paged. Anonymous access allowed with `PUBLISHED_PUBLIC=true` (default false) |
| `GET /templates`, `GET /templates/{id}` | Read only |
| `GET /health`, `/auth/*`, `/me`, `/users?role=`, `/bills/*`, `/search*` | Unchanged |

Removed: `/notes/{id}/assign`, `/exec-chain`, `/lock`, `/revisions`, `/snapshot`, `/versions/{v}/restore`,
`/diff`, `/validate` (validation stays inside save), `/change-requests/*`, `/workflow/duplicate`,
`/export-jobs/*`, `/notes/{id}/exports*`, `/assignments`, `/workflow/summary`,
`/workflow/unassigned-hearings`, `/workflow/poll-deadlines`, `/notifications/*`, `/admin/audit`,
`/admin/ingest/*` (ingest stays a CLI command), `PUT/POST /templates/*`, `/notes/{id}/context`.

### Data

Migration `0008_simplify.sql`:

- `workflow_instances.state`: `todo`, `in_progress` → `draft`; `review.pending`, `review.active`,
  `exec_review.pending`, `exec_review.active` → `in_review`; `cancelled`, `superseded` → `draft`;
  `changes_requested` and `approved` unchanged. `exec_chain`, `exec_index` columns dropped.
- `note_revisions`: add `published_at`, `published_by`, `published_version`; drop `priority`,
  `confidential`, `superseded_by`, `request` columns.
- Drop `workflow_deadlines`, `workflow_assignments`, `notifications`, `note_locks`,
  `note_change_request_items`. `note_change_requests` keeps `summary`, `requested_by`, `requested_at`,
  `resolved_at`, `resolution` (the drafter's submit message).
- `audit_log` and `outbox` stay; the search consumer is the only remaining consumer.

Search indexes bills, sections and amendments only. Notes are found from `/notes` and `/published`.

### Packages

- `workflow-machine`: a transition table replaces XState. `transition(state, event, actor, ctx)` returns the
  next state or a typed refusal; `availableEvents(state, actor, ctx)`; `STATE_LABELS`, `STATE_HINTS`,
  `EVENT_LABELS`. `xstate` is removed from the dependencies.
- `note-schema`: `BillCitation` gains a `sameTarget(a, b)` helper; math nodes stay in the schema so old
  documents still render, but the editor has no way to insert them.
- `apps/web`: `mathlive` removed. `katex` stays for rendering.
- `apps/api`: `nodemailer` removed with the notifications module.

### Demo seed

Four notes on four bills, one per non-final status, plus one published: HB 1004 (Draft, Dana), HB 2081 (In
review, Dana), ESSB 5814 (Changes requested, Dana, request from Rae with two open threads), HB 1019
(Approved, Jordan), SHB 2402 (Published, Dana). `wa-leg demo seed --reset` rebuilds them through the HTTP
API. `docs/DEMO.md`, the guide and the landing page read the same list from one module.

## 3. Work packages

Each package is one branch and one worktree. The integration branch is `simplify/0.2`; package branches are
`simplify/0.2-<name>` off it. WP1 lands first because every other package uses its vocabulary; the
vocabulary is fixed in section 2 so WP2 to WP6 can start against it and rebase when WP1 merges.

### WP1 `workflow` (foundation)

- Rewrite `packages/workflow-machine` as the transition table in section 2 with unit tests for every
  state, event and role.
- `apps/api/src/modules/workflow`: service and routes for the four events; `PUBLISH` writes
  `published_*` on the revision, records a `note.published` outbox event and an audit row; `APPROVE` freezes
  the head version as `approved_version`. `REQUEST_CHANGES` writes the change request row; `SUBMIT` from
  `changes_requested` resolves it with the submit message.
- `apps/api/src/modules/identity`: roles `drafter`, `reviewer`, `viewer`, `admin`; `can()` reduced to the
  matrix in section 2; `toActor()` removed.
- Migration `0008_simplify.sql`.
- `apps/dev-oidc/users.json`: the four users.
- `apps/api/src/db/demo.ts`: the five seeded notes.
- Tests: `apps/api/test/workflow.test.ts`, `can.test.ts`, `notes.test.ts` updated; `change-requests.test.ts`
  reduced to request and resolve.

### WP2 `workspace`

- `WorkflowBar.tsx`: section 2 layout; remove assign, exec chain, deadlines, create revision, newer-version
  notice, audit rows; keep History as the transition list.
- Change request banner and the submit-with-reply dialog.
- `CommentsPanel.tsx`: unchanged behaviour; one dismiss control per form.
- `NoteWorkspace.tsx`: two tabs; remove lock, forced save, templates tab, change requests tab, notice
  plumbing for them; 412 banner with **Reload**.
- `NoteEditor.tsx`: toolbar without Formula and Template; delete `MathDialog.tsx` and the `mathlive`
  dependency.
- e2e: `workflow.spec.ts` rewritten for the path; an assertion that no button named *Cancel* is visible in
  the workflow bar while a dialog is open.

### WP3 `citations`

- `packages/note-schema`: `sameTarget()`; `BillCitation` renders `data-cite-key`.
- `apps/web/src/notes/editorExtension.ts` or a node view: the remove control when editable; keyboard
  removal unchanged.
- `NoteEditor.insertCitation()` returns `'inserted' | 'duplicate'`; `NoteWorkspace.onCite` shows the
  *Already cited* notice on `duplicate`; `BillViewer` status line says *Already cited* rather than *Cited*.
- Unit test for `sameTarget()`; e2e in `notes.spec.ts`: cite twice yields one node, remove control deletes
  it, the document saves without it.

### WP4 `navigation`

- `App.tsx` routes per section 2; delete `DrafterDashboard`, `ReviewerDashboard`, `Inbox`,
  `NoteVersionsPage`, `AdminAudit`, `AdminIngest`, `AdminTemplates`, `TemplatePanel`, `QueueTable` (replaced
  by `NotesList`), `Placeholder`.
- `Shell.tsx`: nav *Notes*, *Published*, *Guide*; no unread badge; footer unchanged.
- `routes/Notes.tsx` (`/notes`) and `routes/Published.tsx` (`/published`).
- `Home.tsx` and `Guide.tsx` rewritten from one `demo.ts` module that exports the users and the seeded
  notes; `BillPage.tsx` right pane uses `PublishedNotePanel` (renamed from `ApprovedNotePanel`) and the
  reduced `NewNoteForm` (version, template, drafter for reviewers).
- e2e: `axe-routes.spec.ts` route list; `login.spec.ts`; `publish.spec.ts` covers `/published`.

### WP5 `api-trim`

- Delete `modules/notifications`, `workflow/deadlines.ts`, locks, snapshots, restore, diff, validate route,
  change request items, export jobs, exports list, admin audit and ingest routes, template write routes,
  `notes/context`, `notes/patch`, `createRevision`, `duplicate`; `nodemailer` and the mail sink in
  `docker-compose.yml` and `deploy/docker-compose.prod.yml` (`/mail` in the Caddyfile).
- `modules/search/docs.ts`: index bills, sections and amendments only; drop the note document and the
  visibility rule; `search/pipeline.ts` and the indexer follow.
- `packages/api-client` regenerated.
- `config.ts`: remove `NOTIFY_EMAIL`, `SMTP_URL`, `MAIL_FROM`, `STATUTORY_HOURS`, `HEARING_LEAD_HOURS`,
  `DEADLINE_POLL_MS`; add `PUBLISHED_PUBLIC`.
- Tests: delete `export.test.ts` cases for comments and jobs; `search.test.ts` for note hits.

### WP6 `publishing`

- `GET /published` and its schema; `PublishedNotePanel` on the bill page shows published notes only, with
  the same earlier-version fallback; `routes/Published.tsx` consumes the feed.
- Export service: viewers and anonymous (when `PUBLISHED_PUBLIC`) get the published version; file names
  `HB2402-S-fiscal-note.pdf`; the PDF footer shows the bill number and *Published <date>*.
- `docs/PUBLISHED-API.md`: the feed and the export URLs for a downstream consumer.
- Tests: `export.test.ts` for the published version rule; e2e `publish.spec.ts`.

### WP7 `docs-and-release` (after integration)

- README, `docs/DEMO.md`, `docs/ARCHITECTURE-AS-BUILT.md`, `docs/OPEN-ITEMS.md` (drop the items whose
  feature is gone), `design/ARCHITECTURE.md` gets a note at the top pointing at this document.
- `CHANGELOG.md` Unreleased section listing the removals and the path.
- `pnpm third-party` after the dependency removals.
- `pnpm release 0.2.0` from `main` after the integration PR merges.

## 4. Acceptance

The path, run end to end on a fresh `pnpm wa-leg demo seed --reset`:

1. Rae opens HB 1483, creates a note for Dana with the sales-use-tax-exemption template. `/notes` shows it
   as Draft for both.
2. Dana opens it, types into the estimate table, cites section 1 (a second Cite on section 1 shows *Already
   cited*), removes the citation with its `×`, cites it again, comments on a sentence, submits with a
   message. Status: In review. Dana's editor is read-only.
3. Rae opens it, comments on two sentences, presses **Request changes**, writes a message. Exactly one
   button labelled Cancel is on screen. Status: Changes requested. Dana sees the banner with the message and
   *2 open comment threads*.
4. Dana resolves both threads, edits, submits with a reply. Status: In review. History shows the request and
   the reply.
5. Rae approves. Status: Approved. The export menu produces PDF, DOCX, HTML and XML of the approved version.
6. Rae publishes. Status: Published. Cam signs in, sees it on `/published` with four export links and beside
   the bill on the bill page. `GET /api/v1/published` lists it.
7. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm third-party` pass. Every remaining
   route is axe clean at 320, 375, 768 and 1280 px in both themes.
8. No route, nav item, button, table, config value, dependency or document refers to a removed feature.
