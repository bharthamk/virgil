#!/usr/bin/env bash
#
# Read-only acceptance for an already deployed Virgil Google estate.
#
#   PROJECT_ID=virgil-506009 ./deploy/audit-live.sh
#
# This script never reads a secret payload and never changes Google Cloud. A
# failure is a release blocker; a warning is an explicit operator decision or
# a control that can be added without rebuilding the product.

set -euo pipefail

cd "$(dirname "$0")/.."
. deploy/config.sh "$@"
require_project

for command in gcloud curl docker node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "missing required command: $command" >&2
    exit 2
  fi
done

pass=0
warn=0
fail=0

passed() { printf '  PASS  %s\n' "$*"; pass=$((pass + 1)); }
warned() { printf '  WARN  %s\n' "$*"; warn=$((warn + 1)); }
failed() { printf '  FAIL  %s\n' "$*"; fail=$((fail + 1)); }

TMP_BODY=$(mktemp)
TMP_HEADERS=$(mktemp)
cleanup() {
  rm -f "$TMP_BODY" "$TMP_HEADERS"
}
trap cleanup EXIT

echo "Virgil live Google acceptance"
echo "project: ${PROJECT_ID}  region: ${REGION}"

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
SERVICE_READY=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.latestReadyRevisionName)')
SERVICE_TRAFFIC=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --format='csv[no-heading](status.traffic.revisionName,status.traffic.percent)')
SERVICE_IMAGE=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(spec.template.spec.containers.image)')

JOB_READY=$(gcloud run jobs describe "$JOB_NAME" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.conditions.status)' | head -1)
JOB_IMAGE=$(gcloud run jobs describe "$JOB_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --format='value(spec.template.spec.template.spec.containers.image)')

echo
echo "release identity"
if [ -n "$SERVICE_READY" ] && [ "$SERVICE_TRAFFIC" = "${SERVICE_READY},100" ]; then
  passed "service ${SERVICE_READY} is Ready at 100% traffic"
else
  failed "service is not Ready at 100% traffic"
fi
if [ "$JOB_READY" = "True" ]; then
  passed "job ${JOB_NAME} is Ready"
else
  failed "job ${JOB_NAME} is not Ready"
fi

SERVICE_TAG=${SERVICE_IMAGE##*:}
JOB_TAG=${JOB_IMAGE##*:}
if [ "$SERVICE_TAG" = "$JOB_TAG" ]; then
  passed "service and Job share immutable release tag ${SERVICE_TAG}"
else
  failed "service tag ${SERVICE_TAG} differs from Job tag ${JOB_TAG}"
fi
case "$SERVICE_TAG" in
  latest|main|master|local|final)
    failed "mutable release tag ${SERVICE_TAG} is not auditable"
    ;;
  *) passed "release tag is not a known mutable alias" ;;
esac

EXPECTED_SOURCE_COMMIT=${EXPECTED_SOURCE_COMMIT:-$(git rev-parse --verify HEAD)}
SERVICE_LABELS=$(docker buildx imagetools inspect "$SERVICE_IMAGE" \
  --format '{{json .Image.Config.Labels}}' 2>/dev/null || true)
JOB_LABELS=$(docker buildx imagetools inspect "$JOB_IMAGE" \
  --format '{{json .Image.Config.Labels}}' 2>/dev/null || true)
label() {
  node -e 'const x=JSON.parse(process.argv[1]||"{}"); process.stdout.write(String(x[process.argv[2]]??""))' "$1" "$2"
}
SERVICE_SOURCE=$(label "$SERVICE_LABELS" org.opencontainers.image.revision)
JOB_SOURCE=$(label "$JOB_LABELS" org.opencontainers.image.revision)
SERVICE_TREE=$(label "$SERVICE_LABELS" dev.virgil.source-tree)
JOB_TREE=$(label "$JOB_LABELS" dev.virgil.source-tree)
SERVICE_DIRTY=$(label "$SERVICE_LABELS" dev.virgil.source-dirty)
JOB_DIRTY=$(label "$JOB_LABELS" dev.virgil.source-dirty)
SERVICE_DIGEST=$(gcloud artifacts docker images describe "$SERVICE_IMAGE" \
  --project "$PROJECT_ID" --format='value(image_summary.digest)' 2>/dev/null || true)
JOB_DIGEST=$(gcloud artifacts docker images describe "$JOB_IMAGE" \
  --project "$PROJECT_ID" --format='value(image_summary.digest)' 2>/dev/null || true)
if printf '%s\n%s\n' "$SERVICE_DIGEST" "$JOB_DIGEST" | grep -Eqv '^sha256:[a-f0-9]{64}$'; then
  failed "service or Job image did not resolve to an immutable sha256 digest"
else
  passed "service and Job image references resolve to immutable digests"
fi
if [ "$SERVICE_SOURCE" = "$EXPECTED_SOURCE_COMMIT" ] && [ "$JOB_SOURCE" = "$EXPECTED_SOURCE_COMMIT" ] \
    && [ -n "$SERVICE_TREE" ] && [ "$SERVICE_TREE" = "$JOB_TREE" ] \
    && [ "$SERVICE_DIRTY" = false ] && [ "$JOB_DIRTY" = false ]; then
  passed "service and Job prove clean common source ${EXPECTED_SOURCE_COMMIT} (${SERVICE_TREE})"
else
  failed "service/Job OCI source identity does not match clean expected commit ${EXPECTED_SOURCE_COMMIT}"
fi

echo
echo "public boundary"
HEALTH_STATUS=$(curl --silent --show-error --max-time 20 \
  --output "$TMP_BODY" --write-out '%{http_code}' "${SERVICE_URL}/health" || true)
if [ "$HEALTH_STATUS" = "200" ] && grep -q '"ok":true' "$TMP_BODY"; then
  passed "/health is 200 and reports ok"
else
  failed "/health did not return the expected green contract (HTTP ${HEALTH_STATUS})"
fi

ANON_STATUS=$(curl --silent --show-error --max-time 20 \
  --output /dev/null --write-out '%{http_code}' "${SERVICE_URL}/board" || true)
if [ "$ANON_STATUS" = "401" ]; then
  passed "anonymous board access is refused with 401"
else
  failed "anonymous board access returned HTTP ${ANON_STATUS}, expected 401"
fi

curl --silent --show-error --max-time 20 --dump-header "$TMP_HEADERS" \
  --output /dev/null --header 'Origin: https://untrusted.invalid' "${SERVICE_URL}/health" || true
if grep -qi '^access-control-allow-origin:' "$TMP_HEADERS"; then
  failed "an untrusted origin received an Access-Control-Allow-Origin header"
else
  passed "an untrusted origin received no CORS authority"
fi

echo
echo "data and authority"
DB_DELETE=$(gcloud firestore databases describe --database='(default)' \
  --project "$PROJECT_ID" --format='value(deleteProtectionState)')
DB_PITR=$(gcloud firestore databases describe --database='(default)' \
  --project "$PROJECT_ID" --format='value(pointInTimeRecoveryEnablement)')
if [ "$DB_DELETE" = "DELETE_PROTECTION_ENABLED" ]; then
  passed "Firestore database deletion protection is enabled"
else
  failed "Firestore database deletion protection is not enabled"
fi
if [ "$DB_PITR" = "POINT_IN_TIME_RECOVERY_ENABLED" ]; then
  passed "Firestore point-in-time recovery is enabled"
else
  warned "Firestore PITR is off; learner backup/restore is the recorded recovery path"
fi

RUNTIME_ROLES=$(gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
  --format='value(bindings.role)' | sort -u)
if [ "$RUNTIME_ROLES" = "roles/datastore.user" ]; then
  passed "runtime project IAM is exactly roles/datastore.user"
else
  failed "runtime project IAM differs from the direct-Gemini least-privilege contract"
fi

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
DEFAULT_COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
DEFAULT_COMPUTE_ROLES=$(gcloud projects get-iam-policy "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${DEFAULT_COMPUTE_SA}" \
  --format='value(bindings.role)' | sort -u)
if [ -z "$DEFAULT_COMPUTE_ROLES" ]; then
  passed "default compute service account has no project role"
else
  failed "default compute service account retains project authority"
fi

JOB_ROLES=$(gcloud run jobs get-iam-policy "$JOB_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:${RUNTIME_SA}" \
  --format='value(bindings.role)' | sort -u)
if [ "$JOB_ROLES" = "roles/run.jobsExecutorWithOverrides" ]; then
  passed "runtime Job IAM is exactly execution-with-overrides"
else
  failed "runtime Job IAM differs from the named-Job contract"
fi

for secret in "$SECRET_NAME" "$FREE_SECRET_NAME" "$NOTEBOOK_DRIVE_SECRET_NAME"; do
  ENABLED=$(gcloud secrets versions list "$secret" --project "$PROJECT_ID" \
    --filter='state=enabled' --format='value(name)' | wc -l | tr -d ' ')
  if [ "$ENABLED" = "1" ]; then
    passed "${secret} has one enabled version"
  elif [ "$ENABLED" = "0" ]; then
    failed "${secret} has no enabled version"
  else
    warned "${secret} has ${ENABLED} enabled versions; review rotation history"
  fi
done

LEGACY_SECRET='virgil-service-shared-secret'
if gcloud secrets describe "$LEGACY_SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  LEGACY_ENABLED=$(gcloud secrets versions list "$LEGACY_SECRET" --project "$PROJECT_ID" \
    --format='value(name,state)' \
    | awk -F '\t' '$2 == "enabled" { count++ } END { print count + 0 }')
  if [ "$LEGACY_ENABLED" = "0" ]; then
    passed "unused legacy shared-secret versions are disabled"
  else
    failed "unused legacy shared-secret still has an enabled version"
  fi
fi

echo
echo "operations"
UPTIME_COUNT=$(gcloud monitoring uptime list-configs --project "$PROJECT_ID" \
  --format='value(name,displayName)' \
  | awk -F '\t' '$2 == "Virgil service health" { count++ } END { print count + 0 }')
POLICY_COUNT=$(gcloud monitoring policies list --project "$PROJECT_ID" \
  --format='value(name,displayName)' \
  | awk -F '\t' '$2 == "Virgil service unavailable" { count++ } END { print count + 0 }')
CHANNEL_COUNT=$(gcloud beta monitoring channels list --project "$PROJECT_ID" \
  --format='value(name,enabled)' \
  | awk -F '\t' '$2 == "True" { count++ } END { print count + 0 }')
if [ "$UPTIME_COUNT" -ge 1 ]; then passed "Cloud Monitoring uptime check exists";
else warned "no Virgil uptime check exists"; fi
if [ "$POLICY_COUNT" -ge 1 ]; then passed "uptime alert policy exists";
else warned "no Virgil uptime alert policy exists"; fi
if [ "$CHANNEL_COUNT" -ge 1 ]; then passed "at least one notification channel is enabled";
else warned "no enabled notification channel exists; incidents stay in the console"; fi

SCAN_STATE=$(gcloud artifacts repositories describe "$REPO" \
  --location "$REGION" --project "$PROJECT_ID" \
  --format='value(vulnerabilityScanningConfig.enablementState)' 2>/dev/null)
if [ "$SCAN_STATE" = "SCANNING_ACTIVE" ]; then
  passed "Artifact Registry vulnerability scanning is active"
else
  warned "Artifact Registry scanning is ${SCAN_STATE:-not configured}; enabling it is a paid decision"
fi

ERROR_COUNT=$(gcloud logging read \
  'resource.type=("cloud_run_revision" OR "cloud_run_job") AND severity>=ERROR AND NOT logName:"cloudaudit.googleapis.com"' \
  --project "$PROJECT_ID" --freshness=24h --limit=50 --format='value(timestamp)' \
  | wc -l | tr -d ' ')
if [ "$ERROR_COUNT" = "0" ]; then
  passed "no Cloud Run ERROR entries in the last 24 hours"
else
  warned "${ERROR_COUNT} Cloud Run ERROR entries exist in the last 24 hours"
fi

echo
printf 'result: %s passed, %s warnings, %s failures\n' "$pass" "$warn" "$fail"
[ "$fail" = 0 ]
