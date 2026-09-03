# Prompt: run the 0.2 simplification as multi-agent work on worktrees

Paste the block below into a Claude Code session opened at the repository root on the `simplify/0.2`
branch. It expects `docs/SIMPLIFY-0.2.md` to be present.

---

You are the lead for the 0.2 simplification of the Fiscal Note Workbench. The plan is
`docs/SIMPLIFY-0.2.md`; read it in full before doing anything. Section 2 is the contract every package
builds against; section 3 defines seven work packages WP1 to WP7; section 4 is the acceptance test. You
coordinate; subagents implement. Use worktrees so packages run in parallel without touching each other's
files.

Environment facts:

- Node 22 comes from nvm and pnpm from corepack. Prefix every shell command with
  `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 22 >/dev/null`.
- Docker services are already up on offset ports: Postgres 5433, OpenSearch 9201, dev OIDC 4801. The API
  runs on 4800 and the web app on 5173. The API runs under tsx without watch: restart it after API changes
  before running e2e (`lsof -ti:4800 | xargs kill`, then `pnpm --filter @wa-leg/api start`).
- Unit tests use `TEST_DATABASE_URL` (default `wa_leg_test`). Two worktrees running `pnpm test` at once
  collide on that database. Give each worktree its own: `TEST_DATABASE_URL=postgres://wa_leg:wa_leg@localhost:5433/wa_leg_test_<name>`.
- The e2e suite needs ports 4800, 4801 and 5173, so only one e2e run can happen at a time. Package agents
  run lint, typecheck and unit tests in their worktree; you run e2e once per integration step from the main
  checkout.
- After any e2e run, `pnpm wa-leg demo seed --reset` restores the demo data.
- Releases: `docs/RELEASE.md`. Commits end with the `Co-Authored-By` trailer this session uses.

Procedure:

1. Setup. Confirm `git status` is clean on `simplify/0.2` and `pnpm install` is done. Create a worktree per
   package: `git worktree add ../wa-leg-wp<N> -b simplify/0.2-<name> simplify/0.2`, then `pnpm install` in
   each. Names: `workflow`, `workspace`, `citations`, `navigation`, `api-trim`, `publishing`.
2. Foundation. Spawn one agent for WP1 in its worktree with the WP1 section, section 2 in full, and the
   environment facts. It must finish with lint, typecheck and the API unit tests green in its worktree, then
   commit. Review its diff against section 2 (state names, event names, route shapes, migration) before
   merging. Merge `simplify/0.2-workflow` into `simplify/0.2` with `--no-ff`.
3. Parallel packages. Spawn WP2, WP3, WP4, WP5 and WP6 at the same time, each in its worktree with its
   section, section 2, the environment facts and the note that WP1 is merged (each agent rebases onto
   `simplify/0.2` first). Each agent: implement, run lint, typecheck and unit tests with its own
   `TEST_DATABASE_URL`, write the e2e changes its section names (without running the suite), commit, and
   report the files it touched and anything in the contract it had to deviate from. Agents do not edit files
   outside their package's list without saying so in the report.
4. Integration. Merge in the order WP5, WP6, WP3, WP2, WP4 into `simplify/0.2`, resolving conflicts
   yourself against section 2. After each merge run lint and typecheck. When all five are in, run
   `pnpm test`, restart the API, run `pnpm test:e2e`, and fix what fails. Then walk section 4 by hand
   with Playwright screenshots at 1280 px: steps 1 to 6 as the named users, saving each screenshot under
   `apps/web/test-results/acceptance/`. A step that does not match section 4 is a defect to fix, not a note.
5. Cleanup sweep. Grep the tree for every removed feature name and route (`exec_review`, `changes_requested`
   items, `deadline`, `notification`, `inbox`, `lock`, `snapshot`, `supersede`, `mathlive`, `template_editor`,
   `approver`, `manager`, `dashboard`, `/admin`, `export-jobs`, `comments=true`). Anything left in code,
   config, docs, tests, `docker-compose`, `deploy/` or the guide is removed. `pnpm third-party` must pass.
6. Docs and release. Spawn WP7 in the main checkout on `simplify/0.2`. Then open a pull request from
   `simplify/0.2` to `main` titled "0.2: one path from draft to Committee" whose body is the CHANGELOG
   Unreleased section plus the acceptance screenshots. Do not merge it; report the PR URL. After the PR
   merges, `pnpm release 0.2.0` is run from `main` by a person.
7. Remove the worktrees (`git worktree remove`) and delete the merged package branches locally.

Report at the end: the PR URL, the list of removed routes and files, the line counts of `apps/web/src` and
`apps/api/src` before and after, the e2e result, and every deviation from section 2 with its reason.
