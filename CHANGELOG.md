# Changelog

Entries go under **Unreleased** as work lands. `pnpm release <version>` moves them under a version heading
(docs/RELEASE.md).

## Unreleased

### Changed

- The app opens in light mode regardless of the operating system setting. A sun/moon switch in the header
  toggles themes and shows which one is on; the choice is stored in the browser and applied before the
  first paint.

## 0.2.1 (2026-09-04)

### Fixed

- Reply box in the Comments tab: typed characters landed in reverse order. The thread list rebuilt its
  component on every keystroke, which remounted the field and put the caret back at the start.
- Note editor: text could not be deleted from a slot inside a locked paragraph. A locked block containing
  the edit blocked the transaction; only a locked block wholly inside the deleted range does now.
- Note editor: the system-filled header fields (Bill Number, Title, Agency) took typed text although they
  refused deletion. Readonly and computed slots now refuse both and render as non-editable.

## 0.2.0 (2026-09-03)

One path from draft to Committee: a fiscal note is drafted, submitted, returned with a change request or
approved, and published for the Committee in four formats (draft → in review → changes requested → approved
→ published). Everything outside that path was removed. The design is `docs/SIMPLIFY-0.2.md`; the feed for
downstream systems is documented in `docs/PUBLISHED-API.md`.

### Added

- `/notes`: one table of the notes the signed-in user can see, grouped by status in path order (bill, title,
  status, drafter, reviewer, updated).
- `/published`: published notes newest first with bill, version, title, published date and PDF, DOCX, HTML
  and XML links. Viewers land here after sign-in.
- `GET /published`: the same list for a downstream consumer, paged with `limit` and an opaque `cursor`,
  response `{ items, nextCursor }`; each item carries `publishedAt`, `publishedBy`, `publishedVersion` and an
  `exports` map of the four URLs.
- `PUBLISHED_PUBLIC` (default `false`): anonymous access to `GET /published` and to the exports of published
  notes.
- Change request banner in the workspace while the status is Changes requested: who, when, the message, and
  the count of open comment threads with a link to the Comments tab.
- Citations render a remove control (`×`, `aria-label="Remove citation Section 2 of SHB 2402"`) while the
  note is editable. Citing a target that is already cited selects the existing citation, scrolls it into
  view and shows *Already cited* instead of inserting a duplicate (`sameTarget()` in `note-schema`).
- A `412` on autosave shows one banner, *This note was saved elsewhere*, with one button, **Reload**.
- `packages/workflow-machine` is a transition table (`transition()`, `availableEvents()`, `STATE_LABELS`,
  `STATE_HINTS`, `EVENT_LABELS`) with a unit test per state, event and role.
- Migration `0008_simplify.sql`: collapses the workflow states, adds `published_at`, `published_by` and
  `published_version` to `note_revisions`, drops the removed tables and columns.
- The WA$ favicon and logo (`apps/web/public/favicon.svg`, `logo.svg`, PNG icons).

### Changed

- Five workflow states (`draft`, `in_review`, `changes_requested`, `approved`, `published`) and four events
  (`SUBMIT`, `REQUEST_CHANGES` with a required message, `APPROVE`, `PUBLISH`), all sent to
  `POST /notes/{id}/workflow`. `GET /notes/{id}/workflow` returns `state`, `drafter`, `reviewer`,
  `availableEvents`, `changeRequest` and `editable`. A note is created in `draft`; the first review action
  sets the reviewer. No claim, cancel, reopen or revision.
- `POST /notes` body: `billKey`, `versionCode`, `templateId` (required), `drafterId` (reviewers only; a
  drafter creates for themselves).
- Note summary fields: `state`, `drafter`, `reviewer`, `headVersion`, `approvedVersion`, `publishedAt`,
  `publishedBy`, `publishedVersion`, `templateId`, `templateVersion`, `mode`, `editable`; deadlines,
  priority, confidential, the executive chain and `supersededBy` are gone.
- Roles: `drafter`, `reviewer`, `viewer`, `admin` (system principal for the CLI and the seed; no screens).
  Test users: Dana Drafter (`dev-drafter`), Rae Reviewer (`dev-reviewer`), Cam Committee (`dev-committee`,
  viewer), Jordan Both (`dev-both`, drafter and reviewer).
- Export version rule: drafters and reviewers get the head version, the approved version of an approved note
  or the published version of a published note; viewers and anonymous callers get the published version
  only (`404` when there is none, `403` for another `version`). File names are
  `{billId}-{versionCode}-fiscal-note.{ext}` (`HB2402-S-fiscal-note.pdf`; `HB1004-fiscal-note.pdf` for an
  introduced bill).
- The PDF, HTML and DOCX footer shows the bill number and *Published <date>* for a published note.
- Search indexes bills, sections and amendments only (with the OFM prior fiscal notes and RCW sections drawn
  from the bill data); workbench notes are no longer indexed and are found from `/notes` and `/published`.
- `wa-leg demo seed --reset` seeds five notes, one per status (HB 1004 Draft, HB 2081 In review, ESSB 5814
  Changes requested, HB 1019 Approved, SHB 2402 Published), and retires the old dev users. The landing page,
  the guide and `docs/DEMO.md` share the list in `apps/web/src/lib/demo.ts`.
- XML export refuses empty required slots only with `strict=true`; the default renders them.
- Workflow bar: bill link and title, status pill with its hint once, drafter, reviewer, the actions for the
  signed-in user's role, **Export** (PDF, DOCX, HTML, XML) and **History**. Dialogs have one dismiss button
  labelled **Cancel** and no workflow action is labelled Cancel. Workspace tabs are *Note* and *Comments*.
- Editor toolbar: bold, italic, underline, superscript, subscript, lists, **Cite**, **Comment**, **Next
  slot**, undo, redo.
- `PublishedNotePanel` (renamed from `ApprovedNotePanel`) on the bill page shows published notes only, with
  the earlier-version fallback.
- Navigation: *Notes*, *Published*, *Guide*.

### Removed

- API routes: `POST /notes/{id}/assign`, `/notes/{id}/exec-chain`, `/notes/{id}/lock` (GET, PUT, DELETE),
  `POST /notes/{id}/revisions`, `POST /notes/{id}/versions` (snapshot), `POST /notes/{id}/versions/{v}/restore`,
  `GET /notes/{id}/diff`, `GET /notes/{id}/validate`, `/notes/{id}/change-requests/*`,
  `POST /notes/{id}/workflow/duplicate`, `GET /export-jobs/{jobId}`, `GET /notes/{id}/exports`,
  `GET /notes/{id}/exports/{exportId}`, `GET /notes/{id}/audit`, `GET /assignments`, `GET /workflow/summary`,
  `GET /workflow/unassigned-hearings`, `POST /workflow/poll-deadlines`, `/notifications/*`, `GET /admin/audit`,
  `GET/POST /admin/ingest/runs`, `PUT /templates/{id}`, `GET /templates/{id}/preview`,
  `GET /notes/{id}/context`, `PATCH /notes/{id}`, `POST /notes/{id}/transitions`. Query options: `comments`
  on export, `force` on `PUT /notes/{id}/document`, `assigned_to_me` on search.
- Web routes `/dashboard/*`, `/inbox`, `/notes/:id/versions`, `/admin/*`, and the files `DrafterDashboard`,
  `ReviewerDashboard`, `Inbox`, `NoteVersionsPage`, `AdminAudit`, `AdminIngest`, `AdminTemplates`,
  `Placeholder`, `TemplatePanel`, `QueueTable`, `NoteList`, `ChangeRequestsPanel`, `MathDialog`.
- Features: executive review chain, claim, reassignment, deadlines and bands, revisions for new bill versions,
  inbox and email notifications, edit locks, forced save, snapshots, restore, the versions page and redline,
  itemised change requests, the templates tab and admin templates editor, formulas, the audit and ingest pages,
  dashboards, priority and confidential flags, note kinds, DOCX with comments.
- API modules `notifications` and `workflow/deadlines`; `modules/admin` became `modules/health`
  (`GET /health` only).
- Roles `approver`, `manager`, `template_editor` and the test users Avery Approver, Morgan Manager, Val
  Viewer, Terry Templates, Ada Admin, Blake Budget.
- Dependencies `xstate`, `nodemailer`, `mathlive`.
- Config values `NOTIFY_EMAIL`, `SMTP_URL`, `MAIL_FROM`, `STATUTORY_HOURS`, `HEARING_LEAD_HOURS`,
  `DEADLINE_POLL_MS`, `REVIEWER_EDIT`, `DIVISION_READ`, `AUTO_REVISION_ON_NEW_VERSION`.
- Tables `workflow_deadlines`, `workflow_assignments`, `notifications`, `note_locks`,
  `note_change_request_items` (migration `0008`).
- The mail sink in `docker-compose.yml`, `deploy/docker-compose.prod.yml` and the `/mail` route in the
  Caddyfile.

### Size

`apps/web/src` 6,912 → 4,995 lines of TypeScript; `apps/api/src` 8,847 → 6,911.

## 0.1.0 (2026-09-03)

Proof of concept of the Fiscal Note Workbench for the Washington Department of Revenue.

- Bill ingest from the Legiscan dataset and lawfilesext XML; bill viewer with outline, version switcher and redline.
- Search over bills, sections, amendments, notes and templates (OpenSearch, or a Postgres fallback).
- Note editor: twelve templates, slots, self-summing estimate tables, citations into the bill, formulas, comments, autosave with version history and redline.
- Review workflow: ten states, itemised change requests, executive review chain, deadlines, inbox and email notifications, audit log.
- Publishing: the approved note beside the bill; export to HTML, PDF, DOCX and a placeholder FNS XML.
- Deployment: one EC2 box, ECR images, deploy through SSM after CI on `main`.
- Release process: `pnpm release`, version and commit in the footer and on `/api/v1/health`.
