#!/usr/bin/env bash
# Copy the deploy files, the Legiscan dataset and the lawfiles cache to the box over SSH.
#
#   HOST=203.0.113.4 bash deploy/sync.sh
set -euo pipefail
: "${HOST:?set HOST to the public IP of the box}"
KEY="${KEY:-$HOME/.ssh/waleg-deploy}"
cd "$(dirname "$0")/.."
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new"
rsync -az -e "$SSH" deploy/docker-compose.prod.yml deploy/bootstrap-box.sh deploy/load-data.sh "ubuntu@$HOST:/srv/waleg/"
rsync -az --delete -e "$SSH" data/WA/2025-2026_Regular_Session/ "ubuntu@$HOST:/srv/waleg/data/legiscan/"
rsync -az -e "$SSH" .cache/lawfiles/ "ubuntu@$HOST:/srv/waleg/data/lawfiles/"
echo synced
