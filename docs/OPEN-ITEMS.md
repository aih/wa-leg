# Open items

Items the design marks as unverified. Each is isolated behind an interface or a configuration value so the
answer can be applied in one place.

| Item | Where isolated | Default in the POC |
|---|---|---|
| FNS XML schema (not public) | `apps/api/src/modules/notes/export/fns-xml.ts` behind `FnsXmlMapper` | Placeholder element names; emits slot values and table cells |
| Start of the 72-hour statutory clock (receipt by OFM or by DOR; clock hours or business hours) | `apps/api/src/modules/workflow/deadlines.ts` `statutoryDueAt()` and config `STATUTORY_CLOCK_START` | Request time + 72 clock hours |
| EBB (bill-tracking surround) integration | `apps/api/src/modules/notes/adapters/request-source.ts` `RequestSource` | Manual request creation through `POST /notes` |
| LSC web service polling in production | `apps/api/src/modules/bills/ingest/lsc-adapter.ts` `FreshnessSource` | Legiscan dataset re-import by `change_hash` |
| Role claim name and group-to-role mapping in Entra ID | config `OIDC_ROLE_CLAIM`, `OIDC_ROLE_MAP` | Dev issuer emits `roles` directly |
| Caucus-drafted amendments (MACK, ADAM and similar drafter codes) have no XML on lawfilesext; 2,473 of the dataset's amendments are metadata only | `apps/api/src/modules/bills/ingest/lawfiles.ts` negative cache; `amendments.status = 'unavailable'` | Listed with disposition and sponsor, no text or diff |
| Templates carry no per-account fy3-fy6 cells; the II.B series inputs (state and local, in thousands) are entered directly | `packages/note-schema/src/template.ts` `finishTemplateDoc()` turns unresolvable `impact-series` cells into `impact.state.fyN` and `impact.local.fyN` inputs | Analyst types the series; the ten-year and biennium totals derive from it |
| Comment anchoring across restores and forced saves: the `comment` mark travels with the text, so a restore to a version without the mark detaches the thread | `apps/api/src/modules/notes/service.ts` `listComments()` marks threads `detached` when no mark is present | Detached threads stay listed under "Detached" and can be resolved or deleted |
| Search visibility of unsubmitted drafts: search.md says a reviewer's search never returns another drafter's draft, while `can()` lets reviewers open a draft they are sent a link to | `apps/api/src/modules/search/docs.ts` `noteVisibility()` | Drafts are indexed for admins and their own participants only |
| MathLive fonts: the editor loads MathLive with `fontsDirectory = null` and relies on the KaTeX font faces already on the page | `apps/web/src/notes/MathDialog.tsx` | Formula rendering uses KaTeX; the input field uses the same faces |
| Reviewer pool: `SUBMIT_FOR_REVIEW` notifies every user with the reviewer or manager role; DOR's routing by division or team is not modelled | `apps/api/src/modules/notifications/service.ts` `onTransitioned()` | All editors are notified; the first to claim gets the review |
| Overdue escalation recipients: `note.overdue` goes to the acting assignee and every user with the manager role | `apps/api/src/modules/workflow/service.ts` `managerIds()` | Managers from `GET /users?role=manager` |
| DOCX formulas: Office Math is produced from a LaTeX subset (fractions, scripts, roots, sums, brackets, common symbols); other constructs stay as source text because the only full converter is LGPL | `apps/api/src/modules/notes/export/latex-omml.ts` | Subset conversion, source-text fallback |
| Export of drafts with empty required slots: HTML, PDF and DOCX allow it (drafts circulate internally); FNS XML refuses with 422 | `apps/api/src/modules/notes/export/service.ts` `strict` option | `strict=true` applies the refusal to every format |
