# Design package: Fiscal Note Workbench

Research and design for a proof-of-concept fiscal note drafting tool for the Washington Department of Revenue, scoped to the core of RFP DOR-RFP-2026-02.

## Read in this order

1. `ARCHITECTURE.md`: decisions, module map, contracts between modules, event catalog, data model, deployment, build order.
2. `IMPLEMENTATION-PROMPT.md`: the prompt to start implementation from a clean session.
3. `api/openapi.yaml`: route catalog and shared schemas.
4. `research/`: the evidence behind each decision.
5. `templates/`: twelve fiscal note templates, a manifest, and the template schema.

## Research reports

| File | Covers |
|---|---|
| `research/rfp-summary.md` | RFP facts, deadlines, scoring, the business and technical requirements this POC targets, what is deferred |
| `research/legiscan-data.md` | Profile of the 2025-26 Legiscan dataset: counts, fields, version suffixes, amendment and fiscal note naming |
| `research/leg-wa-gov-services.md` | LSC web services, lawfilesext XML/HTM/PDF trees and markup, naming conventions, OFM FNS public data, change detection |
| `research/fiscal-notes.md` | Statutory basis, package anatomy, field-by-field DOR note structure, analysis types with examples, computation conventions, formats, implications for the tool |
| `research/bill-viewer.md` | uscode-redesign analysis, principles, Bill Document and Amendment Document schemas, UI, component API, diff design |
| `research/search.md` | Bill reference grammar and parser, OpenSearch indices and queries, ingestion, search API, Postgres fallback |
| `research/editor.md` | Editor library evaluation (Tiptap 3 recommended), document model, custom nodes, template mechanics, comments, export, autosave, component API |
| `research/workflow-engine.md` | Workflow library evaluation (XState v5 recommended), state machine, persistence, deadlines, workflow API |
| `research/personas-dashboards.md` | Personas, permission matrix, status vocabularies, deadlines, dashboard contents, workspace layout, notifications, audit |

## Source material

- `../RFP-docs/` (git-ignored): the RFP, technical requirements, and business requirements.
- `../WA_2025-2026_Regular_Session_JSON_*.zip` (git-ignored): Legiscan dataset.
- Local checkout of `aih/uscode-redesign` at `../../uscode-redesign`.
