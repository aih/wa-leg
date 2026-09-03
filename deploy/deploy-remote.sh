#!/usr/bin/env bash
# Deploy a pushed image tag to the box through SSM Run Command (no SSH needed). Fetches the deploy files for
# the given git ref from GitHub onto the box, then runs bootstrap-box.sh there as the ubuntu user.
#
#   AWS_PROFILE=uscode-admin bash deploy/deploy-remote.sh <tag> [git-ref]
#
# The git ref defaults to the tag (a short SHA is a valid ref). Waits for the command and prints its output.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}"
TAG="${1:?usage: deploy-remote.sh <tag> [git-ref]}"
REF="${2:-$TAG}"
REPO="${GITHUB_REPOSITORY:-aih/wa-leg}"
NAME="${NAME:-waleg-site}"
INSTANCE=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
[ "$INSTANCE" != "None" ] || { echo "no running instance tagged Name=$NAME" >&2; exit 1; }
RAW="https://raw.githubusercontent.com/$REPO/$REF/deploy"
SCRIPT="set -e; cd /srv/waleg
for f in docker-compose.prod.yml bootstrap-box.sh load-data.sh; do curl -fsSL $RAW/\$f -o \$f.new && mv \$f.new \$f; done
chown ubuntu:ubuntu docker-compose.prod.yml bootstrap-box.sh load-data.sh
sudo -u ubuntu -H env IMAGE_TAG=$TAG bash bootstrap-box.sh"
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment "deploy $TAG" \
  --timeout-seconds 900 --parameters "$(python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":["900"]}))' "$SCRIPT")" \
  --query Command.CommandId --output text)
echo "ssm command $CMD on $INSTANCE"
for _ in $(seq 1 180); do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) sleep 5 ;; *) break ;; esac
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text
echo "status: $STATUS"
[ "$STATUS" = "Success" ]
