#!/usr/bin/env bash
# Runs on the box, in /srv/waleg, after deploy/sync.sh copied the deploy files and the data there.
#
#   SITE_ADDRESS=waleg.linkedlegislation.org ACME_EMAIL=you@example.org IMAGE_TAG=abc1234 bash bootstrap-box.sh
#
# Writes .env on the first run (secrets generated; kept on later runs), logs in to ECR with the instance role,
# pulls the images for IMAGE_TAG, migrates and seeds the database, and starts the stack. Re-run with a new
# IMAGE_TAG to deploy a new build; deploy/deploy-remote.sh does that through SSM.
set -euo pipefail
cd "$(dirname "$0")"
ECR_REGISTRY="${ECR_REGISTRY:-739065237548.dkr.ecr.us-east-1.amazonaws.com}"
if [ ! -f .env ]; then
  : "${SITE_ADDRESS:?set SITE_ADDRESS for the first run}"
  : "${ACME_EMAIL:?set ACME_EMAIL for the first run}"
  cat > .env <<ENV
SITE_ADDRESS=$SITE_ADDRESS
ACME_EMAIL=$ACME_EMAIL
ECR_REGISTRY=$ECR_REGISTRY
IMAGE_TAG=${IMAGE_TAG:-latest}
DATA_ROOT=/srv/waleg/data
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
OIDC_CLIENT_SECRET=$(openssl rand -hex 24)
ENV
  chmod 600 .env
  echo ".env written"
fi
grep -q '^ECR_REGISTRY=' .env || echo "ECR_REGISTRY=$ECR_REGISTRY" >> .env
if [ -n "${IMAGE_TAG:-}" ]; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$IMAGE_TAG/" .env
fi
exec 9>.deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null
C="docker compose -f docker-compose.prod.yml"
$C pull --quiet
$C up -d --wait postgres
$C run --rm --no-deps api pnpm wa-leg db migrate
$C run --rm --no-deps api pnpm wa-leg db seed
$C up -d --wait
docker image prune -f >/dev/null
$C ps
