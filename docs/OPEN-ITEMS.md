# Open items

Items the design marks as unverified. Each is isolated behind an interface or a configuration value so the
answer can be applied in one place.

| Item | Where isolated | Default in the POC |
|---|---|---|
| FNS XML schema (not public) | `apps/api/src/modules/notes/export/fns-xml.ts` behind `FnsXmlMapper` | Provisional element names; emits slot values and table cells |
| EBB (bill-tracking surround) integration | `POST /notes` is the only way a note is created | Manual creation from the bill page |
| LSC web service polling in production | `apps/api/src/modules/bills/ingest/lawfiles.ts` and `wa-leg ingest refresh` (ETag / Last-Modified re-check) | Legiscan dataset re-import by `change_hash` |
| Role claim name and group-to-role mapping in Entra ID | config `OIDC_ROLE_CLAIM`, `OIDC_ROLE_MAP` | Dev issuer emits `roles` directly |
| Caucus-drafted amendments (MACK, ADAM and similar drafter codes) have no XML on lawfilesext; 2,473 of the dataset's amendments are metadata only | `apps/api/src/modules/bills/ingest/lawfiles.ts` negative cache; `amendments.status = 'unavailable'` | Listed with disposition and sponsor, no text or diff |
| Templates carry no per-account fy3-fy6 cells; the II.B series inputs (state and local, in thousands) are entered directly | `packages/note-schema/src/template.ts` `finishTemplateDoc()` turns unresolvable `impact-series` cells into `impact.state.fyN` and `impact.local.fyN` inputs | Analyst types the series; the ten-year and biennium totals derive from it |
| Comment anchoring: the `comment` mark travels with the text, so deleting the marked text detaches the thread | `apps/api/src/modules/notes/service.ts` `listComments()` marks threads `detached` when no mark is present | Detached threads stay listed under "Detached" and can be resolved or deleted |
| Reviewer pool: any user with the reviewer role may act on any note In review; DOR's routing by division or team is not modelled | `packages/workflow-machine/src/table.ts` `isReviewer()` | The first reviewer to act becomes the note's reviewer |
| Export of drafts with empty required slots: every format allows it (drafts circulate internally) | `apps/api/src/modules/notes/export/service.ts` `strict` option | `strict=true` refuses with 422 and `details.unfilledSlots` |
| Anonymous access to the published feed and exports | config `PUBLISHED_PUBLIC` | `false`: a session or bearer token is required |
