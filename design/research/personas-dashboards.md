# Personas, permissions, and dashboards

## Personas

| Persona | RFP roles it stands for | Primary screen | What they do |
|---|---|---|---|
| Drafter | RFA analyst; contributing division analyst | Drafter dashboard, drafting workspace | Writes fiscal notes against a bill version; responds to review comments; may also hold review assignments for peers' notes |
| Reviewer / editor | RFA lead, Executive Review chain (division managers, budget office, executive), assigner | Reviewer dashboard, review workspace | Reviews, comments, requests changes, approves; assigns and reassigns work; sets due dates and priority |
| End user | Steering Committee, executives, L&P readers, budget office readers | Bill page with approved note | Reads the approved fiscal note in the context of the bill; no editing |
| Admin (implicit) | DOR IT | Settings | Manages roles, templates, ingest |

A user may hold several roles. Role membership comes from the identity provider (Entra ID groups in production, a static config in development) and is never edited per environment by hand (TR-309).

## Objects and their visibility

| Object | Drafter | Reviewer | End user |
|---|---|---|---|
| Bill, versions, amendments, hearings | read | read | read |
| Prior published fiscal notes (OFM PDFs) | read | read | read |
| Fiscal note draft (to-do, in-progress, address-review) | read/write if assigned; read if same division (configurable) | read; comment | none |
| Fiscal note in review (ready-for-review) | read; comment reply | read; comment; transition | none |
| Fiscal note approved | read | read | read |
| Review comments | read/write own thread | read/write | none |
| Assignments | own | all in scope | none |
| Audit log | own note's history | all in scope | none |
| Templates | read; apply | read; apply; edit if template-editor | none |

Sensitivity flag: a note can be marked confidential (B.COM.04, B.COM.16). Confidential notes are visible only to assignees, assigned reviewers, and admins, even after approval, until the flag is cleared.

## Permission model

Permissions are checked server-side on every request from a (role, object state, relationship) triple.

| Permission | Who |
|---|---|
| note.create | reviewer (assigner), admin; drafter for self-assigned estimates |
| note.edit | assigned drafter when state in {to-do, in-progress, address-review}; reviewer only in address-review with "reviewer edit" enabled |
| note.submit_for_review | assigned drafter |
| note.review (comment, request changes, approve) | assigned reviewer for the current review step |
| note.reopen after approval | reviewer with approver role, admin (B.COM.23) |
| note.assign / reassign / cancel / duplicate | reviewer (assigner), admin |
| note.export | drafter and reviewer on notes they can read; end user on approved notes |
| note.read_approved | everyone with the viewer role |
| template.edit | template-editor role |
| ingest.run, search.reindex | admin |

## Status vocabularies

One underlying workflow state per note; two role-facing labels.

| Workflow state | Drafter sees | Reviewer sees | Who acts |
|---|---|---|---|
| todo | To do | Unstarted | Drafter starts |
| in_progress | In progress | Drafting | Drafter submits |
| ready_for_review | Ready for review | Pending my review → In review when opened | Reviewer approves or requests changes |
| address_review | Address review | Changes requested | Drafter revises and resubmits |
| approved | Approved | Approved | Reviewer may reopen |
| cancelled | Cancelled | Cancelled | Assigner |

Multi-step Executive Review: `ready_for_review` carries a reviewer sequence `[step1, step2, ...]`; approval at a non-final step advances the step and notifies the next reviewer and the previous ones; changes requested at any step returns the note to `address_review`. The workflow engine report defines the machine in detail.

## Deadlines

Each note has:

- `statutory_due_at`: request time + 72 clock hours (RCW 43.88A).
- `hearing_due_at`: earliest upcoming hearing on the bill version minus 4 hours, recomputed when `calendar[]` changes.
- `internal_due_at` per step: set by the assigner (B.COM.13, B.RFA.04).
- `effective_due_at` = min of the above; dashboards sort by it and colour by remaining time (>24h, 4-24h, <4h, overdue) with a text label as well as colour.

## Drafter dashboard

Sections, each a table with bill number, version, title, state, effective due, hearing, reviewer, last activity:

1. My notes needing action: `todo`, `in_progress`, `address_review`, sorted by effective due.
2. My notes waiting on others: `ready_for_review`.
3. My review assignments (if the drafter also reviews).
4. Recently approved (last 14 days).
5. Bill change alerts: bills with my notes where a new version, amendment, or hearing appeared since the note was last edited (B.COM.02).

Row actions: open workspace, view bill, request reassignment.

## Reviewer dashboard

1. Pending my review, sorted by effective due; flag the step number in a chain.
2. Changes requested, waiting on drafter.
3. Team queue (assigner view): all notes in scope grouped by state, with assignee, priority, due dates; bulk assign and reassign; create note from a bill.
4. Unassigned bills with hearings within 72 hours that have no note (from calendar data): the trigger for automatic task creation.
5. Approved this session, with export links.

## End-user view

The bill page. Header (number, version switcher, title, sponsors, status, next hearing), the bill text, and a "Fiscal note" panel showing the approved note for the selected version, with export to PDF and DOCX, and a link to the OFM-published package if one exists. If no approved note exists for the version, the panel says so and shows the latest approved note for an earlier version, labelled as such. Works on a phone-width screen (B.EXEC.02): the panels stack, bill text collapsed by default.

## Workspace layout (drafter and reviewer)

Two panes with a draggable splitter. Left: bill viewer (collapsible to a 48 px rail that keeps the outline). Right: note editor (drafter) or note in read mode with comment threads (reviewer). A top bar shows state, due countdown, assignees, and the transition buttons allowed for the current user. The editor stays mounted while the bill pane scrolls; the bill pane stays mounted while the editor scrolls.

## Notifications

In-app inbox plus email adapter (SMTP in dev, M365 Graph in production). Events: assigned, reassigned, submitted for review, changes requested, approved, due in 24 hours, due in 4 hours, overdue, bill changed (new version, new amendment, hearing scheduled or moved).

## Audit

Every transition, assignment change, document version save, export, and permission-denied attempt writes an audit row: actor, action, object, before/after state, timestamp, request id (TR-1004).
