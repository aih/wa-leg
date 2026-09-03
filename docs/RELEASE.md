# Releases

A release is a git tag `vX.Y.Z` on a commit, a GitHub release with the changelog section for that version,
and images in ECR tagged with the same `vX.Y.Z`. The version lives in every workspace `package.json`; the
footer of the web app and `GET /api/v1/health` report it together with the short commit hash.

## Cutting a release

1. Land the work. Add a line for each change under `## Unreleased` in `CHANGELOG.md` as it merges.
2. From a clean tree on the branch to release, run the checks: `pnpm lint && pnpm typecheck && pnpm test`.
3. `pnpm release X.Y.Z`. The script:
   - refuses a dirty tree, an existing tag, or an empty Unreleased section;
   - sets `version` in every workspace `package.json`;
   - renames `## Unreleased` to `## X.Y.Z (date)` and adds an empty Unreleased section above it;
   - commits `Release vX.Y.Z`, creates the annotated tag, pushes the branch and the tag;
   - creates the GitHub release with the changelog section as its notes (`gh` must be signed in).
   `--dry-run` prints the steps without changing anything; `--no-push` stops after the tag.
4. Deploy: run the **Deploy** workflow from the Actions tab with the tag as the ref, or from a laptop
   `git checkout vX.Y.Z && AWS_PROFILE=uscode-admin bash deploy/build-push.sh` followed by
   `bash deploy/deploy-remote.sh <image tag> vX.Y.Z`. `build-push.sh` tags the images with the short SHA,
   `latest`, and the release tag when one points at HEAD.
5. Check `https://waleg.linkedlegislation.org/api/v1/health`: `version` and `commit` name the release.

## Version and commit in the build

| Where | Source |
|---|---|
| Web footer | `apps/web/vite.config.ts` defines `__APP_VERSION__` from the root `package.json` and `__GIT_SHA__` from `GIT_SHA` or `git rev-parse --short HEAD` |
| `GET /api/v1/health`, OpenAPI `info.version` | `apps/api/src/lib/version.ts`, same sources |
| Docker images | `deploy/build-push.sh` passes `--build-arg GIT_SHA`; the Dockerfiles export it as `GIT_SHA` |

A build without a git checkout and without `GIT_SHA` shows `unknown`.

## Numbering

`0.x.y` while the tool is a proof of concept. Bump the minor number for a milestone that changes the
workflow, the data model, or the API; the patch number for fixes.
