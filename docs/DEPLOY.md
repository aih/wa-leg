# Deployment

The demo runs on one EC2 instance in AWS account 739065237548 (us-east-1) at
https://waleg.linkedlegislation.org. Everything the box runs is in `deploy/`.

## Shape

| Piece | Where |
|---|---|
| Instance | `t4g.small` (2 vCPU, 2 GB, arm64), Ubuntu 24.04, 30 GB gp3 root, 2 GB swap, tag `Name=waleg-site` |
| Elastic IP | 98.82.227.72, tag `Name=waleg-site` |
| Security group | `waleg-site`: 80 and 443 from anywhere, 22 from the address that ran `provision.sh` |
| Instance profile | `uscode-site` (shared with the uscode box): SSM agent registration |
| Images | ECR `waleg/api`, `waleg/web`, `waleg/oidc`, built for arm64 and tagged with the short git SHA (`-dirty` when built from a changed tree) and `latest` |
| Stack | `deploy/docker-compose.prod.yml`: Postgres 16, the API, the dev OIDC issuer, Mailpit, Caddy |
| Data | `/srv/waleg/data/{legiscan,lawfiles,exports}` bind mounts; Postgres and Caddy state in named volumes |
| DNS | Route 53 hosted zone `Z007577931KDAIYFR232H` (`linkedlegislation.org`); `waleg` A record to the Elastic IP |
| Deploy trigger | `.github/workflows/deploy.yml`: after the CI workflow succeeds on `main`, or by hand from the Actions tab |

Caddy serves the web bundle and terminates TLS with a Let's Encrypt certificate. `/api/*` goes to the
API, `/oidc/*` to the dev issuer (prefix stripped; the issuer URL is `https://waleg.linkedlegislation.org/oidc`),
`/mail/*` to the Mailpit inbox that receives the notification emails. Search uses the Postgres backend;
there is no OpenSearch on the box. PDF export uses the Chromium installed in the API image.

Approximate monthly cost: instance $12, storage $2.40, Elastic IP $3.60, ECR storage about $0.20.

## Files

| File | Runs where | Purpose |
|---|---|---|
| `deploy/provision.sh` | laptop | Security group, instance (with `deploy/cloud-init.yaml` as user data), Elastic IP, DNS record. Idempotent |
| `deploy/dns.sh` | laptop | Upsert the A record in Route 53 and wait for it to sync |
| `deploy/build-push.sh` | laptop or Actions | Build the three arm64 images and push them to ECR |
| `deploy/deploy-remote.sh` | laptop or Actions | Through SSM: fetch the deploy files for a git ref onto the box and run `bootstrap-box.sh` |
| `deploy/sync.sh` | laptop | rsync the compose file, the box scripts, `data/WA/2025-2026_Regular_Session` and `.cache/lawfiles` to the box |
| `deploy/bootstrap-box.sh` | box | Write `.env` on first run, log in to ECR with the instance role, pull, migrate, seed, start |
| `deploy/iam-deploy-policy.json` | console | The Route 53 and ECR grant attached to the deploy user |
| `deploy/load-data.sh` | box | Ingest the Legiscan dataset, build the search table, wait for the outbox to drain, create the demo notes |
| `deploy/api.Dockerfile`, `web.Dockerfile`, `oidc.Dockerfile`, `Caddyfile` | build | Image definitions |

## AWS identity

The `linkedlegislation-deploy` IAM user (local profile `uscode-admin`) has what the scripts need:
`ec2:RunInstances`, security groups, Elastic IPs, `iam:PassRole` for `uscode-site`, `ssm:SendCommand`,
and, from `deploy/iam-deploy-policy.json`, the `waleg` record in the hosted zone and push and pull on
ECR `waleg/*`. It cannot create key pairs (the SSH key goes in through cloud-init) and has no IAM, RDS,
ECS or Lightsail access. The same user's access key is stored as the repository secrets
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the deploy workflow.

## First deployment

```sh
export AWS_PROFILE=uscode-admin
bash deploy/provision.sh                       # instance, Elastic IP, DNS record
HOST=98.82.227.72 bash deploy/sync.sh
bash deploy/build-push.sh                      # prints the image tag
ssh -i ~/.ssh/waleg-deploy ubuntu@98.82.227.72
  cd /srv/waleg
  SITE_ADDRESS=waleg.linkedlegislation.org ACME_EMAIL=<you> IMAGE_TAG=<sha> bash bootstrap-box.sh
  bash load-data.sh                            # whole session; BILLS=HB2402,SB6137 for a subset
```

Caddy obtains the certificate once the DNS record resolves; `docker compose -f docker-compose.prod.yml
restart proxy` forces a retry.

To test before the DNS record exists, set `SITE_ADDRESS=98-82-227-72.sslip.io` in `.env` and run
`docker compose -f docker-compose.prod.yml up -d api oidc proxy`; sslip.io resolves that name to the IP
and Caddy gets a certificate for it. Set it back the same way.

The ingest of the whole session takes a few minutes with the lawfiles cache in place. It leaves about
19,000 outbox events (one per bill and bill version) that the running API works through at a few per
second; `load-data.sh` waits for that backlog before it creates the demo notes, because the seed drains
the outbox itself and gives up when the notes' events are stuck behind the bills'.

## Updating

A merge to `main` deploys itself: the CI workflow runs, and when it succeeds the Deploy workflow builds
the images on an arm64 runner, pushes them to ECR, and runs `deploy-remote.sh`, which fetches that
commit's `deploy/` files onto the box and runs `bootstrap-box.sh` through SSM. The Actions tab also
offers **Run workflow** for a manual deploy of any branch. Runs are serialized by the `deploy`
concurrency group.

The same from a laptop:

```sh
export AWS_PROFILE=uscode-admin
TAG=$(bash deploy/build-push.sh | tail -1)
bash deploy/deploy-remote.sh "$TAG" "$(git rev-parse HEAD)"   # the ref must be pushed to GitHub
```

`bootstrap-box.sh` re-runs the migrations and the reference seed before restarting the stack; it does
not touch notes. Bill data changes are still copied with `sync.sh` and loaded with `load-data.sh`. `pnpm wa-leg demo seed --reset` inside the API container rebuilds the demo notes:

```sh
docker compose -f docker-compose.prod.yml run --rm --no-deps api pnpm wa-leg demo seed --reset
```

## Operations

- Logs: `docker compose -f docker-compose.prod.yml logs -f api` (also `proxy`, `oidc`, `postgres`).
- Without SSH: `aws ssm start-session --target <instance-id>` needs `ssm:StartSession`, which the deploy
  user lacks; `aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript
  --parameters 'commands=["..."]'` works, and `deploy-remote.sh` shows the pattern.
- Rollback: `bash deploy/deploy-remote.sh <previous-tag> <previous-sha>`; ECR keeps every tag.
- The SSH rule allows one address. Change it with `aws ec2 authorize-security-group-ingress
  --group-name waleg-site --protocol tcp --port 22 --cidr <ip>/32`.
- Resize: `aws ec2 stop-instances`, `aws ec2 modify-instance-attribute --instance-type t4g.medium`,
  `aws ec2 start-instances`. The Elastic IP and volume stay attached.
- Backup: `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U wa_leg wa_leg | gzip > wa_leg.sql.gz`.
- Tear down: terminate the instance, release the Elastic IP, delete the security group, the Route 53
  record and the three ECR repositories.

## Differences from the production design

`design/ARCHITECTURE.md` describes ECS Fargate, RDS, Amazon OpenSearch Service and Entra ID. This
deployment is the demo shape: one box, Postgres in a container, the Postgres search backend, and the
development issuer with its fixed test users. The Mailpit inbox at `/mail/` is public and shows every
notification email the demo sends.
