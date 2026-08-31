#!/usr/bin/env bash
#
# Build both images for Cloud Run and push them to Artifact Registry.
#
#   ./deploy/build.sh --plan                     # prints, changes nothing
#   VIRGIL_DEPLOY=yes PROJECT_ID=... ./deploy/build.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/config.sh "$@"

echo "the suite, on the runtime the images use — not on the one this repo is developed on"
run docker run --rm -v "$PWD":/w -w /w --network none \
  "$(grep -m1 '^ARG BUILDER_IMAGE=' deploy/Dockerfile | cut -d= -f2-)" npm test

require_project
[ "$PLAN" = 1 ] || require_confirmation

echo
echo "APIs"
run gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com \
  iam.googleapis.com \
  --project "$PROJECT_ID"

echo
echo "the registry"
# Reuse the registry when it exists; create it otherwise.
if [ "$PLAN" = 1 ]; then
  printf '  would run: gcloud artifacts repositories create %s (if absent)\n' "$REPO"
else
  gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || gcloud artifacts repositories create "$REPO" \
         --repository-format=docker --location "$REGION" --project "$PROJECT_ID"
fi
run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo
echo "the images — linux/amd64, because Cloud Run supports the Linux x86_64 ABI"
# Not negotiable and not a variable. An arm64-only image will not deploy.
# <https://docs.cloud.google.com/run/docs/building/containers>
run docker buildx build --platform "$PLATFORM" \
  -f deploy/Dockerfile --target job -t "$IMAGE_JOB" --push .
run docker buildx build --platform "$PLATFORM" \
  -f deploy/Dockerfile --target service -t "$IMAGE_SERVICE" --push .

echo
echo "  job:     $IMAGE_JOB"
echo "  service: $IMAGE_SERVICE"
echo
echo "next: ./deploy/apply.sh"
