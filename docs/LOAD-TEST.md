# Load test

Run on 2026-09-03 09:32 UTC against http://localhost:4800 with autocannon: 60 requests/s (60 users × 3 burst at one request every 3 s) over 180 connections, 20 s per read scenario; autosave on one connection at full speed.
Targets (ARCHITECTURE.md): P95 under 500 ms for reads and under 1 s for saves.

| Scenario | Connections | Requests | Req/s achieved | P50 ms | P95 ms | P99 ms | Errors | Target met |
|---|---|---|---|---|---|---|---|---|
| GET bill document (SHB 2402) | 180 | 1200 | 60 | 18 | 47 | 58 | 0 | yes |
| GET search (8 rotating queries) | 180 | 1200 | 60 | 54 | 306 | 330 | 0 | yes |
| GET search suggest (sales) | 180 | 1200 | 60 | 18 | 51 | 57 | 0 | yes |
| GET note summary + workflow | 180 | 1201 | 60 | 24 | 94 | 109 | 0 | yes |
| GET drafter queue | 180 | 1208 | 60 | 8 | 84 | 88 | 0 | yes |
| PUT autosave (force, 1 connection) | 1 | 783 | 78 | 12 | 17 | 19 | 0 | yes |

Run with `pnpm load` while `pnpm dev` (or the API alone) is up and the Legiscan dataset is loaded. `CONNECTIONS` and `DURATION` override the defaults.
