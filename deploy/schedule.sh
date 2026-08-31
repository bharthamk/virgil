#!/usr/bin/env bash
#
# An optional fixed-board Cloud Scheduler floor.
#
#   ./deploy/schedule.sh --plan
#   VIRGIL_DEPLOY=yes PROJECT_ID=... ./deploy/schedule.sh
#
# The signed-in product does not need this clock. A threshold-crossing pin or an
# explicit Process press makes a request-bound Cloud Run Jobs API call, carrying
# the verified learner board and the learner-day batch key into that execution.
#
# This optional script invokes the Job directly for the single BOARD_ID in its
# deployed template. It is not a multi-user sweep and does not publish a message
# nobody consumes. Re-running is create-or-update.

set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/config.sh "$@"
require_project
[ "$PLAN" = 1 ] || require_confirmation

URI="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"

# `create` the first time, `update` afterwards, so re-running this is not an
# error and not a second job.
verb_for() {
  local kind=$1 name=$2
  if gcloud scheduler jobs describe "$name" \
       --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    echo update
  else
    echo create
  fi
}

# The event-driven processing contract: nothing in this product needs a Scheduler job. The batch runs when
# a pin arrives and the learner has asked for automatic processing, or when they
# press Process. This script creates a cron only if a deployment explicitly asks
# for one, and says so rather than doing nothing quietly.
if [ "${VIRGIL_SCHEDULE:-off}" != "on" ]; then
  echo "VIRGIL_SCHEDULE is off, so no Cloud Scheduler job is created."
  echo "The batch is triggered by a pin arriving, or by the learner pressing Process."
  echo "Set VIRGIL_SCHEDULE=on to add an hourly sweep for the configured fixed board."
  exit 0
fi

echo
echo "the shared runtime identity already needs execution-with-overrides on the job"
run gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --member "serviceAccount:${RUNTIME_SA}" \
  --role roles/run.jobsExecutorWithOverrides \
  --region "$REGION" --project "$PROJECT_ID"

echo
echo
echo "the fixed-board sweep — ${SCHEDULE_RUN} ${TIME_ZONE}"
if [ "$PLAN" = 1 ]; then
  printf '  would run: gcloud scheduler jobs create http %s --uri %s\n' "$SCHEDULER_RUN_NAME" "$URI"
else
  VERB=$(verb_for http "$SCHEDULER_RUN_NAME")
  gcloud scheduler jobs "$VERB" http "$SCHEDULER_RUN_NAME" \
    --location "$REGION" \
    --schedule "$SCHEDULE_RUN" \
    --time-zone "$TIME_ZONE" \
    --uri "$URI" \
    --http-method POST \
    --oauth-service-account-email "$RUNTIME_SA" \
    --project "$PROJECT_ID"
fi

echo
echo "prove it without waiting for the next hour:"
echo "  gcloud scheduler jobs run ${SCHEDULER_RUN_NAME} --location ${REGION}"
echo "  gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION}"
