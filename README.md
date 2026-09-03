# Fiscal Note Workbench

Proof-of-concept fiscal note drafting tool for the Washington Department of Revenue. A drafter reads a bill,
writes the fiscal note against a specific bill version, a reviewer approves it, and end users read the approved
note beside the bill text. The design is in `design/`; `design/ARCHITECTURE.md` is the specification.

## Layout

| Path | Contents |
|---|---|
| `apps/api` | Fastify service under `/api/v1`; OpenAPI at `/api/v1/openapi.json`; the `wa-leg` CLI |
| `apps/web` | React 19 + Vite + React Router web app |
| `apps/dev-oidc` | Development OpenID Connect issuer with one test user per role |
| `packages/workflow-machine` | XState v5 review workflow, shared by server and client |
| `packages/billref` | Bill reference parser |
| `packages/bill-document` | Bill Document schema, XML parser, section diff |
| `packages/note-schema` | Tiptap extensions, template loader, estimate validator |
| `packages/api-client` | Client generated from the OpenAPI document |
| `docs/` | As-built notes and `OPEN-ITEMS.md` |

## Development

Requirements: Node 22, pnpm 11 (`corepack enable`), Docker.

```sh
cp .env.example .env
docker compose up -d            # Postgres 5433, OpenSearch 9201, mail sink 8026, dev OIDC 4801
pnpm install
pnpm wa-leg db migrate
pnpm wa-leg db seed
pnpm dev                        # API on 4800, web on 5173, dev OIDC on 4801
```

Open http://localhost:5173 and sign in. The dev issuer lists the test users:

| User | Roles |
|---|---|
| Dana Drafter | drafter |
| Rae Reviewer | reviewer |
| Avery Approver | reviewer, approver |
| Morgan Manager | manager |
| Val Viewer | viewer |
| Terry Templates | template_editor, drafter |
| Ada Admin | admin |
| Jordan Both | drafter, reviewer |
| Blake Budget | reviewer, approver (Budget division) |

`?login_hint=dev-drafter` on `/api/v1/auth/login` skips the picker.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test                       # unit and route tests; needs Postgres (creates wa_leg_test)
pnpm test:e2e                   # Playwright; starts the dev issuer, API, and web app
pnpm third-party                # writes THIRD_PARTY.md and fails on a non-permissive license
```

## Data

Unzip the Legiscan dataset to `data/` and load it:

```sh
unzip WA_2025-2026_Regular_Session_JSON_*.zip -d data
pnpm wa-leg ingest legiscan data/WA/2025-2026_Regular_Session --limit 20
pnpm wa-leg search init
pnpm wa-leg search load
```
