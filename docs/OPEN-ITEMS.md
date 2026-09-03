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
