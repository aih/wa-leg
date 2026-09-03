#!/usr/bin/env bash
# Create the waleg-site box: security group, one t4g.small Ubuntu 24.04 arm64 instance with the uscode-site
# instance profile (SSM access and ECR pull), an Elastic IP, and the DNS A record. Idempotent: re-running
# reuses what exists.
#
#   AWS_PROFILE=uscode-admin ADMIN_CIDR=203.0.113.4/32 bash deploy/provision.sh
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}"
NAME="${NAME:-waleg-site}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.small}"
INSTANCE_PROFILE="${INSTANCE_PROFILE:-uscode-site}"
ADMIN_CIDR="${ADMIN_CIDR:-$(curl -s https://checkip.amazonaws.com)/32}"
cd "$(dirname "$0")/.."

SG=$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name "$NAME" --description "Fiscal Note Workbench demo site" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$ADMIN_CIDR" >/dev/null
  echo "security group $SG created (22 from $ADMIN_CIDR)"
else
  echo "security group $SG exists"
fi

INSTANCE=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$INSTANCE" = "None" ]; then
  AMI=$(aws ec2 describe-images --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" "Name=state,Values=available" \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
  INSTANCE=$(aws ec2 run-instances \
    --image-id "$AMI" \
    --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile "Name=$INSTANCE_PROFILE" \
    --security-group-ids "$SG" \
    --user-data file://deploy/cloud-init.yaml \
    --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" "ResourceType=volume,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  echo "instance $INSTANCE launched from $AMI"
else
  echo "instance $INSTANCE exists"
fi
aws ec2 wait instance-running --instance-ids "$INSTANCE"

ALLOC=$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" --query 'Addresses[0].AllocationId' --output text)
if [ "$ALLOC" = "None" ]; then
  ALLOC=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId --output text)
  echo "elastic IP $ALLOC allocated"
fi
ASSOC=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].InstanceId' --output text)
if [ "$ASSOC" != "$INSTANCE" ]; then
  aws ec2 associate-address --allocation-id "$ALLOC" --instance-id "$INSTANCE" >/dev/null
fi
IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" --query 'Addresses[0].PublicIp' --output text)
echo "public IP: $IP"
bash deploy/dns.sh "$IP"
