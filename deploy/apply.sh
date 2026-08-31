#!/usr/bin/env bash
#
# Render the two YAML files and apply them.
#
#   ./deploy/apply.sh --plan                     # renders + prints, changes nothing
#   VIRGIL_DEPLOY=yes PROJECT_ID=... ./deploy/apply.sh
#
# A real apply writes `*.rendered.yaml` beside the templates so what was
# actually applied remains readable. `--plan` writes separate `*.plan.yaml`
# files; a rehearsal must never overwrite the last rollout receipt. Both are
# gitignored because they carry deployment-specific public configuration.
#
# The reference estate has exercised this path. A new installation still needs
# to run it in its own project; `--plan` remains read-only.

set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/config.sh "$@"
require_project
require_browser_identity

render() {
  sed -e "s|__IMAGE_JOB__|${IMAGE_JOB}|g" \
      -e "s|__IMAGE_SERVICE__|${IMAGE_SERVICE}|g" \
      -e "s|__RUNTIME_SA__|${RUNTIME_SA}|g" \
      -e "s|__PROJECT_ID__|${PROJECT_ID}|g" \
      -e "s|__BOARD_ID__|${BOARD_ID}|g" \
      -e "s|__REGION__|${REGION}|g" \
      -e "s|__JOB_NAME__|${JOB_NAME}|g" \
      -e "s|__FIREBASE_API_KEY__|${FIREBASE_API_KEY}|g" \
      -e "s|__GOOGLE_WEB_CLIENT_ID__|${GOOGLE_WEB_CLIENT_ID}|g" \
      -e "s|__OWNER_EMAIL__|${OWNER_EMAIL}|g" \
      -e "s|__ALLOWED_EMAILS__|${ALLOWED_EMAILS}|g" \
      -e "s|__JUDGE_DEMO_PASSWORD_SHA256__|${JUDGE_DEMO_PASSWORD_SHA256}|g" \
      -e "s|__SECRET_NAME__|${SECRET_NAME}|g" \
      -e "s|__FREE_SECRET_NAME__|${FREE_SECRET_NAME}|g" \
      -e "s|__NOTEBOOK_DRIVE_SECRET_NAME__|${NOTEBOOK_DRIVE_SECRET_NAME}|g" \
      -e "s|__NOTEBOOK_URL__|${NOTEBOOK_URL}|g" \
      "$1" > "$2"
  if grep -q '__[A-Z_]*__' "$2"; then
    echo "unrendered placeholder left in $2:" >&2
    grep -o '__[A-Z_]*__' "$2" | sort -u >&2
    exit 2
  fi
  echo "  rendered $2"
}

if [ "$PLAN" = 1 ]; then
  JOB_OUTPUT=deploy/job.plan.yaml
  SERVICE_OUTPUT=deploy/service.plan.yaml
else
  JOB_OUTPUT=deploy/job.rendered.yaml
  SERVICE_OUTPUT=deploy/service.rendered.yaml
fi

echo "rendering"
render deploy/job.yaml     "$JOB_OUTPUT"
render deploy/service.yaml "$SERVICE_OUTPUT"

echo
echo "the two model secrets and the managed Notebook grant (or disabled sentinel) must exist before either resource references one"
for secret in "$SECRET_NAME" "$FREE_SECRET_NAME" "$NOTEBOOK_DRIVE_SECRET_NAME"; do
  if [ "$PLAN" = 1 ]; then
    printf '  would check: gcloud secrets describe %s\n' "$secret"
    continue
  fi
  gcloud secrets describe "$secret" --project "$PROJECT_ID" >/dev/null 2>&1 || {
    cat >&2 <<EOF
No secret named ${secret}.

Create the two Gemini secrets from the appropriate model key. For
${NOTEBOOK_DRIVE_SECRET_NAME}, store either the managed Drive OAuth JSON
described in README.md or the literal `disabled` when that optional lane is off.
Secret values are deliberately not scripted here: a script that creates one is
a script that can print one.

  gcloud secrets create ${secret} --data-file=- --project ${PROJECT_ID}

Re-run apply.sh after creating it. The normal apply path creates the runtime
identity when needed and grants access to these three named secrets.

EOF
    exit 2
  }
done

[ "$PLAN" = 1 ] || require_confirmation

echo
echo "the dedicated runtime identity"
runtime_identity_id="${RUNTIME_SA%%@*}"
runtime_identity_domain="${RUNTIME_SA#*@}"
if [ "$PLAN" = 1 ]; then
  printf '  would ensure service account: %s\n' "$RUNTIME_SA"
elif ! gcloud iam service-accounts describe "$RUNTIME_SA" --project "$PROJECT_ID" >/dev/null 2>&1; then
  if [ "$runtime_identity_domain" != "${PROJECT_ID}.iam.gserviceaccount.com" ] \
      || [ -z "$runtime_identity_id" ]; then
    echo "RUNTIME_SA does not exist and is not a creatable service account in ${PROJECT_ID}: ${RUNTIME_SA}" >&2
    exit 2
  fi
  gcloud iam service-accounts create "$runtime_identity_id" \
    --display-name "Virgil runtime" --project "$PROJECT_ID"
fi

echo
echo "the default Firestore database"
if [ "$PLAN" = 1 ]; then
  printf '  would ensure Firestore (default) exists in %s\n' "$FIRESTORE_LOCATION"
elif ! gcloud firestore databases describe --database='(default)' \
    --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud firestore databases create --database='(default)' \
    --location "$FIRESTORE_LOCATION" --type firestore-native --project "$PROJECT_ID"
fi

echo
echo "deny every direct Firestore client before the service is published"
run npx --no-install firebase deploy --only firestore:rules --project "$PROJECT_ID"

echo
echo "protect the database itself from accidental deletion"
run gcloud firestore databases update --database='(default)' \
  --delete-protection --project "$PROJECT_ID"

echo
echo "the runtime identity may read learner boards"
run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role roles/datastore.user

# The checked-in templates use the Gemini API and API keys, not Vertex AI.
# `roles/aiplatform.user` would therefore be unused project-wide authority.
# The code's optional `SB_LLM=vertex` route is documented in GOOGLE_BACKEND.md;
# an operator choosing it grants that role deliberately with the model change.

echo
echo "the runtime identity may read only the three named secrets"
for secret in "$SECRET_NAME" "$FREE_SECRET_NAME" "$NOTEBOOK_DRIVE_SECRET_NAME"; do
  run gcloud secrets add-iam-policy-binding "$secret" \
    --member "serviceAccount:${RUNTIME_SA}" \
    --role roles/secretmanager.secretAccessor --project "$PROJECT_ID"
done

echo
echo "the service — validated first. \`services replace\` has --dry-run; \`jobs replace\` does not."
run gcloud run services replace "$SERVICE_OUTPUT" \
  --region "$REGION" --project "$PROJECT_ID" --dry-run

echo
echo "the worker first — the new service must never arrive before its target"
run gcloud run jobs replace "$JOB_OUTPUT" \
  --region "$REGION" --project "$PROJECT_ID"

echo
echo "the service identity may execute this Job with per-learner overrides"
run gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role roles/run.jobsExecutorWithOverrides \
  --region "$REGION" --project "$PROJECT_ID"

echo
echo "the service — last, after its worker and permission exist"
run gcloud run services replace "$SERVICE_OUTPUT" \
  --region "$REGION" --project "$PROJECT_ID"

# Deliberately NOT granting allUsers. `services replace` leaves the IAM policy
# alone. The service template disables the invoker IAM check deliberately:
# Firebase Auth is the browser-reachable gate, and the application verifies its
# ID token before selecting a learner board. CLOUD_RUN.md R1.

echo
echo "next: ./deploy/schedule.sh, then run the live execution gate:"
echo "  gcloud run jobs execute ${JOB_NAME} --region ${REGION} --wait"
