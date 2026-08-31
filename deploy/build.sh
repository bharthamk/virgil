#!/usr/bin/env bash
#
# Build both images for Cloud Run and push them to Artifact Registry.
#
#   ./deploy/build.sh --plan                     # prints, changes nothing
#   VIRGIL_DEPLOY=yes PROJECT_ID=... ./deploy/build.sh
#
# The reference estate has exercised this path. A new installation still needs
# to run it in its own project; `--plan` remains read-only.

set -euo pipefail
cd "$(dirname "$0")/.."
SOURCE_COMMIT=$(git rev-parse --verify HEAD)
SOURCE_TREE=$(git rev-parse 'HEAD^{tree}')
export IMAGE_TAG="${IMAGE_TAG:-$SOURCE_COMMIT}"
. deploy/config.sh "$@"

SOURCE_DIRTY=false
if [ -n "$(git status --porcelain=v1 --untracked-files=all)" ]; then SOURCE_DIRTY=true; fi
if [ "$SOURCE_DIRTY" = true ] && [ "$PLAN" != 1 ] && [ "${VIRGIL_ALLOW_DIRTY_BUILD:-}" != yes ]; then
  echo "Refusing a release image build from a dirty tree. Use a clean exact worktree, or VIRGIL_ALLOW_DIRTY_BUILD=yes for an explicitly non-release development image." >&2
  exit 2
fi

echo "the suite, on the runtime the images use — not on the one this repo is developed on"
run docker run --rm -v "$PWD":/w -w /w --network none \
  "$(grep -m1 '^ARG BUILDER_IMAGE=' deploy/Dockerfile | cut -d= -f2-)" npm test

require_project
[ "$PLAN" = 1 ] || require_confirmation

echo
echo "APIs"
run gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com firebaserules.googleapis.com \
  generativelanguage.googleapis.com identitytoolkit.googleapis.com \
  securetoken.googleapis.com iam.googleapis.com \
  --project "$PROJECT_ID"

echo
echo "the registry"
# `|| true` is wrong here on purpose being avoided: a repo that already exists
# is not an error worth stopping for, but any other failure is.
if [ "$PLAN" = 1 ]; then
  printf '  would run: gcloud artifacts repositories create %s (if absent)\n' "$REPO"
else
  gcloud artifacts repositories describe "$REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
    || gcloud artifacts repositories create "$REPO" \
         --repository-format=docker --location "$REGION" --project "$PROJECT_ID"
fi
run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

echo
echo "immutable image identity"
if [ "$PLAN" = 1 ]; then
  printf '  would verify unused image tags: %s and %s\n' "$IMAGE_JOB" "$IMAGE_SERVICE"
else
  for image in "$IMAGE_JOB" "$IMAGE_SERVICE"; do
    if gcloud artifacts docker images describe "$image" --project "$PROJECT_ID" >/dev/null 2>&1; then
      echo "Refusing to reuse mutable release tag: $image" >&2
      echo "Choose a new immutable IMAGE_TAG; an existing image is release evidence, not a destination." >&2
      exit 2
    fi
  done
fi

echo
echo "the images — linux/amd64, because Cloud Run supports the Linux x86_64 ABI"
# Not negotiable and not a variable. An arm64-only image will not deploy.
# <https://docs.cloud.google.com/run/docs/building/containers>
run docker buildx build --platform "$PLATFORM" \
  --label "org.opencontainers.image.revision=${SOURCE_COMMIT}" \
  --label "org.opencontainers.image.version=${IMAGE_TAG}" \
  --label "dev.virgil.source-tree=${SOURCE_TREE}" \
  --label "dev.virgil.source-dirty=${SOURCE_DIRTY}" \
  -f deploy/Dockerfile --target job -t "$IMAGE_JOB" --push .
run docker buildx build --platform "$PLATFORM" \
  --label "org.opencontainers.image.revision=${SOURCE_COMMIT}" \
  --label "org.opencontainers.image.version=${IMAGE_TAG}" \
  --label "dev.virgil.source-tree=${SOURCE_TREE}" \
  --label "dev.virgil.source-dirty=${SOURCE_DIRTY}" \
  -f deploy/Dockerfile --target service -t "$IMAGE_SERVICE" --push .

echo
echo "  job:     $IMAGE_JOB"
echo "  service: $IMAGE_SERVICE"
echo "  source:  $SOURCE_COMMIT ($SOURCE_TREE), dirty=$SOURCE_DIRTY"
echo
echo "next: ./deploy/apply.sh"
