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
