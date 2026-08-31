#!/usr/bin/env bash
#
# Deployment configuration, in one place.
#
# Sourced by build.sh, apply.sh and schedule.sh. Every value is overridable from
# the environment, so nothing here has to be edited to point at a different
# project.
#
# **Nothing in this directory creates anything without VIRGIL_DEPLOY=yes.** That
# is not politeness — `GCP_SETUP_2026-08-20.md` rules that nothing is deployed
# before credits arrive, and a script that could be run by accident is a script
# that will be.

: "${PROJECT_ID:=}"
: "${REGION:=us-central1}"
: "${REPO:=virgil}"
: "${JOB_NAME:=virgil-nightly}"
: "${SERVICE_NAME:=virgil-service}"
: "${FIRESTORE_LOCATION:=nam5}"
: "${FIREBASE_API_KEY:=}"
: "${GOOGLE_WEB_CLIENT_ID:=}"
# Optional fixed-board sweep. The signed-in product uses request-bound Job
# dispatch with an explicit learner-day key; this cron is only a recovery floor
# for the one BOARD_ID named by the operator.
: "${SCHEDULER_RUN_NAME:=virgil-nightly-run}"

# One learner's board. This is what `new JsonStore(path)` named on a laptop —
# `boards/{boardId}` in the Firestore lane's mapping.
: "${BOARD_ID:=demo-learner}"

# Hourly, in UTC, when explicitly enabled.
#
# **Etc/UTC, not Europe/London.** The zone is not about where the learner lives;
# it is that a DST zone shifts by an hour twice a year, so a cron pinned to one
# walks across the night boundary and back without anybody editing anything.
# Etc/UTC is fixed, and with VIRGIL_TRIGGER_NIGHT_BOUNDARY_H=0 the cron and the
# night key are measured in the same clock.
#
# The scheduler is optional and off by default. Automatic processing is driven
# by new material crossing the configured threshold, so idle boards do not
# create background work or model cost.
#
# One Scheduler job is kept because a deployment may still want a floor under
# its nominated fixed board — but `VIRGIL_SCHEDULE=off` is
# the default, `apply.sh` creates no Scheduler job unless it is set to `on`, and
# nothing in the product needs one. When it IS on, the Job runs
# `process --if-due`, which now means "only if there is a reason" rather than
# "only if the hour has come", so an idle sweep costs a container start and
# zero model calls.
#
# Still `Etc/UTC` when used, and still for the reason it always was: a zone that
# shifts twice a year walks the sweep across an hour with nobody editing
# anything.
: "${VIRGIL_SCHEDULE:=off}"
: "${SCHEDULE_RUN:=0 * * * *}"
: "${TIME_ZONE:=Etc/UTC}"

# The secrets. Both are created by their owner during deployment.
# Deliberately not scripted: a script that creates a secret is a script that can
# print one.
#
#   virgil-gemini-api-key          the model key, from ~/.config/virgil/env
: "${SECRET_NAME:=virgil-gemini-api-key}"
# The free arm of the key ladder: the free-tier key the
# deployment spends first, with the paid key above as the budget-gated
# fallback. Optional in the code (no variable, no ladder) but named in both
# YAMLs here, so this estate always deploys with the ladder on.
: "${FREE_SECRET_NAME:=virgil-gemini-api-key-free}"
# Standard OAuth client + refresh token for the learner-selected Drive account.
# The secret also names the account so a foreground file-id handoff cannot arm
# a worker holding a grant for somebody else. A fresh installation that does
# not use managed Drive still creates this secret with the literal `disabled`;
# the application treats that sentinel as the optional lane being off.
: "${NOTEBOOK_DRIVE_SECRET_NAME:=virgil-notebook-drive-credential}"
# Public destination of the notebook that consumes Virgil's three stable Drive
# sources. Optional: without it, Notebook buttons open the product home.
: "${NOTEBOOK_URL:=}"
: "${OWNER_EMAIL:=}"
: "${ALLOWED_EMAILS:=}"
# Optional private Demo mode. Empty is off. Supply only a SHA-256 digest; the
# password itself never enters a rendered deployment file or this repository.
: "${JUDGE_DEMO_PASSWORD_SHA256:=}"

: "${IMAGE_TAG:=$(git rev-parse --short HEAD 2>/dev/null || echo local)}"

# Cloud Run supports the Linux x86_64 ABI. The docs say it in as many words for
# this exact case: "if you are using a Mac with Apple silicon, you must specify
# --platform linux/amd64". Not a variable, and not a choice.
# <https://docs.cloud.google.com/run/docs/building/containers>
PLATFORM=linux/amd64

if [ -n "${PROJECT_ID}" ]; then
  REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}"
  IMAGE_JOB="${REGISTRY}/nightly:${IMAGE_TAG}"
  IMAGE_SERVICE="${REGISTRY}/service:${IMAGE_TAG}"
fi

# The runtime identity needs:
#   roles/secretmanager.secretAccessor   on ${SECRET_NAME}
#   roles/datastore.user                 for Firestore
#   roles/run.jobsExecutorWithOverrides  on the Job, for durable per-learner work
# The shipped Gemini API route needs no Vertex AI IAM role. An operator who
# deliberately changes both templates to `SB_LLM=vertex` additionally grants
# roles/aiplatform.user; the default installer does not pre-grant unused power.
# The optional Scheduler uses this same runtime identity.
: "${RUNTIME_SA:=virgil-runtime@${PROJECT_ID:-PROJECT}.iam.gserviceaccount.com}"

require_project() {
  if [ -z "${PROJECT_ID}" ]; then
    echo "PROJECT_ID is not set. There is no project yet; that is the point." >&2
    exit 2
  fi
}

# Public browser configuration, but deployment-specific all the same. The
# installer creates or discovers these for the self-hoster's Firebase project;
# a blank value would deploy `/app/` with a sign-in button that cannot work.
require_browser_identity() {
  if [ -z "${FIREBASE_API_KEY}" ] || [ -z "${GOOGLE_WEB_CLIENT_ID}" ] \
      || { [ -z "${OWNER_EMAIL}" ] && [ -z "${ALLOWED_EMAILS}" ]; }; then
    cat >&2 <<'EOF'
FIREBASE_API_KEY, GOOGLE_WEB_CLIENT_ID and OWNER_EMAIL are required.
For an existing installation, the first ALLOWED_EMAILS entry remains the owner
fallback so an upgrade cannot lock the current operator out.

They are public browser configuration for this self-hosted deployment, not
shared Virgil credentials. GOOGLE_WEB_CLIENT_ID must be a Web application OAuth
client whose authorised JavaScript origin is the service origin. The separate
Chrome-extension client belongs in the packaged extension, never this service
template. Installation provisions both; apply.sh will not publish a board whose
hosted sign-in door cannot work. OWNER_EMAIL bootstraps the installation owner;
ALLOWED_EMAILS may provide initial members. The durable directory is then
managed by the owner in Settings, keeping personal addresses out of public
source.
EOF
    exit 2
  fi
}

# The one gate. Every script that would create, push or bill calls this.
require_confirmation() {
  if [ "${VIRGIL_DEPLOY:-}" != "yes" ]; then
    cat >&2 <<'EOF'
Refusing to run.

This script creates or bills Google Cloud resources, and the standing rule is
that nothing is deployed before credits arrive. Re-run with:

    VIRGIL_DEPLOY=yes PROJECT_ID=... ./deploy/<script>.sh

Without it, pass --plan to print exactly what would run and change nothing.
EOF
    exit 2
  fi
}

# `--plan` on any script prints the commands instead of running them.
PLAN=0
for arg in "$@"; do
  [ "$arg" = "--plan" ] && PLAN=1
done

run() {
  if [ "$PLAN" = 1 ]; then
    printf '  would run: %s\n' "$*"
  else
    "$@"
  fi
}
