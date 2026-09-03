#!/usr/bin/env bash
# Build the three images for linux/arm64 and push them to ECR. Run on an arm64 host (a Mac, or the
# ubuntu-24.04-arm runner in GitHub Actions).
#
#   AWS_PROFILE=uscode-admin bash deploy/build-push.sh [tag]
#
# The tag defaults to the short git SHA (-dirty appended when the tree has changes); each image is also tagged
# latest, and with the release tag (v0.1.0) when one points at HEAD. GIT_SHA is passed to the build so the web
# footer and /api/v1/health report the commit. Prints the tag on the last line.
set -euo pipefail
export AWS_REGION="${AWS_REGION:-us-east-1}"
cd "$(dirname "$0")/.."
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
SHA=$(git rev-parse --short HEAD)
TAG="${1:-$SHA$(git diff --quiet HEAD || echo -dirty)}"
# A release tag on HEAD (v0.1.0) is pushed as a third image tag.
RELEASE=$(git describe --tags --exact-match --match 'v*' 2>/dev/null || true)
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
for name in api oidc web; do
  aws ecr describe-repositories --repository-names "waleg/$name" >/dev/null 2>&1 || aws ecr create-repository --repository-name "waleg/$name" >/dev/null
  docker build --platform linux/arm64 --build-arg "GIT_SHA=$SHA" -f "deploy/$name.Dockerfile" \
    -t "$REGISTRY/waleg/$name:$TAG" -t "$REGISTRY/waleg/$name:latest" ${RELEASE:+-t "$REGISTRY/waleg/$name:$RELEASE"} .
  docker push --quiet "$REGISTRY/waleg/$name:$TAG"
  docker push --quiet "$REGISTRY/waleg/$name:latest"
  [ -z "$RELEASE" ] || docker push --quiet "$REGISTRY/waleg/$name:$RELEASE"
done
echo "pushed to $REGISTRY/waleg/{api,oidc,web}"
echo "$TAG"
