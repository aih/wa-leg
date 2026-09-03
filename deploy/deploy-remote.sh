#!/usr/bin/env bash
# Deploy a pushed image tag to the box: fetch the deploy files for a git ref from GitHub onto the box and run
# bootstrap-box.sh there.
#
#   AWS_PROFILE=uscode-admin bash deploy/deploy-remote.sh <tag> [git-ref]
#
# The git ref defaults to the tag (a short SHA is a valid ref) and must be pushed to GitHub.
# DEPLOY_METHOD=ssm (default) runs the script through SSM Run Command and needs the ssm:SendCommand grant in
# deploy/iam-deploy-policy.json; the workflow uses this. DEPLOY_METHOD=ssh connects as ubuntu with $SSH_KEY
# (default ~/.ssh/waleg-deploy) and needs a security-group rule for the caller's IP; for a laptop.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}"
TAG="${1:?usage: deploy-remote.sh <tag> [git-ref]}"
REF="${2:-$TAG}"
REPO="${GITHUB_REPOSITORY:-aih/wa-leg}"
NAME="${NAME:-waleg-site}"
METHOD="${DEPLOY_METHOD:-ssm}"
RAW="https://raw.githubusercontent.com/$REPO/$REF/deploy"
FILES="docker-compose.prod.yml bootstrap-box.sh load-data.sh"

INSTANCE=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
[ "$INSTANCE" != "None" ] || { echo "no running instance tagged Name=$NAME" >&2; exit 1; }

case "$METHOD" in
  ssm)
    SCRIPT="set -e; cd /srv/waleg
for f in $FILES; do curl -fsSL $RAW/\$f -o \$f.new && mv \$f.new \$f; done
chown ubuntu:ubuntu $FILES
sudo -u ubuntu -H env IMAGE_TAG=$TAG bash bootstrap-box.sh"
    PARAMS=$(python3 -c 'import json,sys; print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":["900"]}))' "$SCRIPT")
    CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment "deploy $TAG" \
      --timeout-seconds 900 --parameters "$PARAMS" --query Command.CommandId --output text)
    echo "ssm command $CMD on $INSTANCE"
    STATUS=Pending
    for _ in $(seq 1 180); do
      STATUS=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
      case "$STATUS" in Pending|InProgress|Delayed) sleep 5 ;; *) break ;; esac
    done
    aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text
    echo "status: $STATUS"
    [ "$STATUS" = "Success" ]
    ;;
  ssh)
    SSH_KEY="${SSH_KEY:-$HOME/.ssh/waleg-deploy}"
    IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "ubuntu@$IP" "set -e; cd /srv/waleg
for f in $FILES; do curl -fsSL $RAW/\$f -o \$f.new && mv \$f.new \$f; done
IMAGE_TAG=$TAG bash bootstrap-box.sh"
    ;;
  *) echo "DEPLOY_METHOD must be ssm or ssh" >&2; exit 1 ;;
esac
echo "deployed $TAG ($REF) to $INSTANCE"
