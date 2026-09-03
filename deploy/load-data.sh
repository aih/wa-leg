#!/usr/bin/env bash
# Runs on the box after bootstrap-box.sh: load the Legiscan dataset, build the search table, wait for the
# API to work through the ingest events, and create the demo notes. Bill text comes from the lawfiles cache
# under data/lawfiles; anything missing is fetched.
#
#   bash load-data.sh            # every bill of the session
#   BILLS=HB2402,SB6137 bash load-data.sh
set -euo pipefail
cd "$(dirname "$0")"
C="docker compose -f docker-compose.prod.yml"
if [ -n "${BILLS:-}" ]; then
  $C run --rm --no-deps api pnpm wa-leg ingest legiscan /data/legiscan --bills "$BILLS"
else
  $C run --rm --no-deps api pnpm wa-leg ingest legiscan /data/legiscan
fi
$C run --rm --no-deps api pnpm wa-leg search init
$C run --rm --no-deps api pnpm wa-leg search load
# The ingest writes one outbox event per bill and version; the running API's relay consumes them at a few per
# second. The demo seed drains the outbox itself, so it has to start on an empty backlog.
while :; do
  n=$($C exec -T postgres psql -U wa_leg -tAc "select count(*) from outbox where published_at is null")
  [ "${n// /}" = "0" ] && break
  echo "outbox backlog: $n events; waiting"
  sleep 30
done
$C run --rm --no-deps api pnpm wa-leg demo seed --reset
