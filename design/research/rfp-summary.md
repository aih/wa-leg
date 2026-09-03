# RFP DOR-RFP-2026-02 summary and traceability

Source: `RFP-docs/RFP 2026-02 - DOR Legislative Tracking System.docx`, `RFP-docs/Technical requirements.docx`, `RFP-docs/Full Project Requirements Specification Template.docx` (Exhibit A business requirements), and the appendices embedded in the RFP (A-F).

## Procurement facts

| Item | Value |
|---|---|
| Requisition | DOR-RFP-2026-02, "Legislation Tracking System Replacement Solution" |
| Posted | August 7, 2026 |
| Questions due | September 1, 2026 |
| Administrative documents (App. A-C) due | September 28, 2026, 5:00 p.m. PT |
| Full proposals (App. D-F) due | October 5, 2026, 5:00 p.m. PT |
| Evaluations | October 6 - November 5, 2026 |
| Vendor demonstrations (up to 4 bidders) | November 9-13, 2026. Bidders must show a complete proof of concept. |
| Apparent Successful Bidder | November 25, 2026 |
| Ceiling | $1,120,000. Award to the lowest priced responsive and responsible bidder (RCW 39.26.160). DOR expects the real cost to be lower. |
| Scoring | App. D experience 20, App. E implementation 30, App. F architecture 50, demonstration 50. Total 150. |
| Minimum qualifications | Licensed in WA within 30 days of award; five years' experience with similar solutions. Preferred: WA legislative process and WA fiscal note experience. |
| Delivery models accepted | Vendor SaaS (configured), DOR-hosted custom build in DOR's AWS, or vendor-hosted custom build. DOR uses AWS. |

## The incumbent system and the problem

The current Legislative Tracking System (LTS) is an in-house application from 2007. It supports bill and amendment analysis, issue identification, fiscal notes (bill descriptions, revenue and expenditure estimates, review and approval), and fiscal estimates (informal, year-round documents with the same structure as fiscal notes).

Volumes per session: 300-500 fiscal notes, 500-700 bill analyses, up to 800 bills and 1,500 amendments tracked, 11 divisions contributing, more than 60 concurrent users. Fiscal notes are due within 72 clock hours and at least 4 hours before a hearing. Bill descriptions are due within 48 hours.

Stated limitations of the incumbent: slowdowns under session load, limited concurrency, no workflow status indicators, manual formatting, no spell check, no rich text, shadow systems, click-to-focus defects (TR-106), permissions that differ between environments (TR-309).

## System deliverables named in the RFP (section 1.5)

- Unified platform for fiscal notes, bill descriptions, and policy analysis for the RFA and L&P divisions.
- Automated ingestion of bills, versions, and amendments; version and amendment comparison; automated task creation and notifications on new versions, amendments, and deadlines.
- Standardized templates and structured editors; export to XML, Word, and PDF compliant with OFM requirements.
- Role-based queues, workload dashboards, reviewer tools; secure handoffs and visibility restrictions for analysts, reviewers, assigners, managers, leadership.
- Audit logs and sensitivity-based visibility.
- Integration with the Legislative Service Center (LSC) API, OFM's Fiscal Note System (FNS), OFM's Bill Enrollment and Agency Request System (BEARS), SharePoint/M365.
- Reporting at queue, bill, and workload level.
- Session-ready operations: concurrency, uptime, statutory deadlines (48-hour bill description, 72-hour fiscal note, rapid turnaround for hearings inside 72 hours), autosave, WCAG 2.2 AA.

## Business requirements relevant to the fiscal note core

Exhibit A numbers are B.COM.nn (common), B.RFA.nn (Research and Fiscal Analysis), B.LNP.nn (Legislation and Policy), B.EXEC.nn, B.BGT.nn, B.EXP.nn.

| Requirement | Text (abridged) | POC module |
|---|---|---|
| B.COM.02 | Notifications on task assignment and on external bill changes | Workflow, Ingest |
| B.COM.03 | Auto-assign a unique identifier to every work product | Notes |
| B.COM.05 | Link all versions of a bill (draft, HB, SHB, ...) and fiscal notes to the bill or a package | Bills, Notes |
| B.COM.06 | Role-based permissions: prepare, approve, deliver, read-only | Auth |
| B.COM.08 | View multiple documents simultaneously | Bill viewer + editor layout |
| B.COM.09 | Robust search to locate any task, document, bill | Search |
| B.COM.10 | Work queues showing all work assigned to a user with status, priority | Dashboard |
| B.COM.11-13, 18, 23 | Create, assign, reassign, cancel, duplicate tasks; multiple assignees with per-role due dates; correct after approval | Workflow |
| B.COM.14 | Track the customer's due date per work product | Workflow |
| B.COM.15, 19 | Defined workflow: one user works, different users review and approve; multi-reviewer approval before external release | Workflow |
| B.COM.17 | Self-contained rich text editor with spell check for designated work products | Editor |
| B.COM.22 | Save work in progress | Editor (autosave) |
| B.COM.24-27 | Custom templates populated with system data; modify templates at any time; share templates | Templates |
| B.COM.28-29 | Transfer content from prior work products, including prior years, without copy and paste | Notes (clone from prior note) |
| B.COM.31-32 | Pull new bill language and status automatically from external systems in real time | Ingest |
| B.COM.33, 35 | Retain every prior version of bills and work products | Bills, Notes (immutable versions) |
| B.COM.34 | Extract any work product in any format | Export |
| B.COM.36 | Pull FTE, cost rules, revenue fund data from internal DOR systems; calculate fiscal notes | Editor (estimate tables), out of POC scope for live integration |
| B.COM.37 | Documentation of how fiscal work papers are completed; research historical notes | Search over approved notes |
| B.COM.43 | Bill history across the biennium | Bills |
| B.RFA.01-02 | Executive Review permissions and the full Executive Review workflow inside the solution, with automatic notification of prior and next reviewer | Workflow |
| B.RFA.03 | Override auto-assigned identifiers | Notes |
| B.RFA.04-05 | Due date per step; priority per work product | Workflow |
| B.RFA.06 | Packages: deliver several work products as one, with package status | Deferred |
| B.RFA.09 | Rich text editor with spell check for fiscal estimates and data requests | Editor (full mode) |
| B.RFA.10 | Limited editor with spell check for fiscal notes | Editor (limited mode) |
| B.LNP.01-02 | Import unadopted amendments from leg.wa.gov, EBB, LSC API; compare a draft bill to prior versions including prior sessions | Ingest, Bill viewer diff |
| B.LNP.09 | Review entire fiscal notes | Reviewer persona |
| B.EXEC.01-03 | Use without VPN, on a DOR phone; the most important bill information, analysis and fiscal notes on one screen | End-user persona, responsive layout |
| B.BGT.01 | Enter and update expense estimate elements included in fiscal work products | Editor (expenditure tables) |
| B.EXP.01 | View ten years of prior work products | Deferred (data migration) |

## Technical requirements that shape the POC

| ID | Type | Requirement (abridged) | POC stance |
|---|---|---|---|
| TR-104 | S | AWS or Azure preferred | Container-first; deployable to AWS |
| TR-105 | S | Limit lock-in; portable services | Postgres, OpenSearch, S3-compatible storage, no proprietary workflow service |
| TR-106 | M | Every interactive element responds to one click | UI acceptance criterion |
| TR-107 | M | No end-of-life components | Pin currently supported versions |
| TR-302 | M | TLS 1.2+, AES-256 at rest | Deployment concern |
| TR-303 | M | Entra ID via OIDC; no custom credential store | OIDC client in the auth module; dev-mode stub issuer |
| TR-305 | M | RBAC, least privilege | Roles: drafter, reviewer, approver, viewer, admin |
| TR-309 | M | Role provisioning automated and identical across environments | Roles from Entra groups mapped in config, seeded by migration |
| TR-403 | M | RPO 4 hours, RTO 24 hours | Deployment concern |
| TR-501-502 | M | WCAG 2.2 AA; ACR/VPAT before go-live | UI acceptance criterion |
| TR-601 | M | Versioned REST APIs, OAuth 2.0 for API auth | OpenAPI 3.1, `/api/v1` |
| TR-602 | MS | Integrate with systems in the System Integration Inventory (BT is named; the inventory is not yet published) | Adapter interfaces only |
| TR-603 | S | OpenAPI documentation and versioning | Generated OpenAPI |
| TR-604 | M | SharePoint/M365 for file storage of bills, notes, etc. | Storage adapter interface; local filesystem or S3 in POC |
| TR-701, 703 | MS/M | Git; peer-reviewed pull requests | Repo practice |
| TR-801 | M | Automated CI/CD | GitHub Actions |
| TR-902 | MS | Minimum automated unit test coverage | Tests per module |
| TR-1001-1004 | M | Centralized logs, monitoring, audit logging of auth and data changes | Structured logs; audit table |
| TR-1104-1108 | MS | P95 latency targets, sustained and 3x burst throughput | Stateless API, indexed queries |
| TR-1301-1306 | M | DOR owns data; export on exit; no proprietary lock-in components; SBOM | Open-source stack; export endpoints |
| TR-1501-1502 | M | Disclose every FOSS component and license | Keep a `THIRD_PARTY.md` |
| TR-1601-1602 | M | Disclose every AI component | None in the POC core; any drafting assistance is an optional adapter |

Appendix F (architecture, 50 points) asks for: architecture style, deployment approach, context/component/deployment diagrams, security architecture, hosting, scalability model, integration architecture, data architecture, reliability, maintainability, technology stack. The POC design documents in this directory are organized so that they can be lifted into that appendix.

## What the POC covers and what it leaves out

In scope: bill ingest from Legiscan JSON and leg.wa.gov text; bill viewer with versions, amendments, and diff; search with bill-reference parsing; fiscal note drafting with templates, estimate tables, and formulas; review and approval workflow with assignments, due dates, and audit; dashboards for drafter, reviewer, and end user; export to HTML, DOCX, PDF, and a provisional FNS XML; REST API for all of it.

Out of scope, left as adapter interfaces: FNS/BEARS transmission, SharePoint storage, Entra ID production federation, internal DOR fiscal data systems (FTE and cost rules), bill descriptions and policy analysis products, packages, data requests, legislative implementation tracking, reporting beyond dashboard counts, legacy data migration.
