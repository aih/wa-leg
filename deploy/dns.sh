#!/usr/bin/env bash
# Upsert the A record for the site in Route 53 and wait for the change to propagate.
#
#   AWS_PROFILE=uscode-admin bash deploy/dns.sh 98.82.227.72
set -euo pipefail
IP="${1:?usage: dns.sh <ip>}"
ZONE="${ZONE_NAME:-linkedlegislation.org.}"
NAME="${SITE_ADDRESS:-waleg.linkedlegislation.org}"
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$ZONE" --max-items 1 --query 'HostedZones[0].Id' --output text | sed 's#/hostedzone/##')
CHANGE=$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --query ChangeInfo.Id --output text --change-batch "{
  \"Changes\": [{\"Action\": \"UPSERT\", \"ResourceRecordSet\": {
    \"Name\": \"$NAME\", \"Type\": \"A\", \"TTL\": 300, \"ResourceRecords\": [{\"Value\": \"$IP\"}]}}]}")
aws route53 wait resource-record-sets-changed --id "$CHANGE"
echo "$NAME A $IP (zone $ZONE_ID) in sync"
