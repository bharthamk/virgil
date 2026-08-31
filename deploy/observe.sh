#!/usr/bin/env bash
#
# Idempotent Cloud Monitoring setup for Virgil's anonymous, data-free health
# endpoint. Use --plan first. Mutating use requires the same explicit gate as
# every other deploy script.
#
#   PROJECT_ID=virgil-506009 ./deploy/observe.sh --plan
#   VIRGIL_DEPLOY=yes PROJECT_ID=virgil-506009 ./deploy/observe.sh
#
# ALERT_CHANNELS may contain comma-separated, already-created Monitoring
# notification-channel resource names. Empty is valid: incidents remain visible
# in Cloud Monitoring, but no email, webhook or external message is sent.

set -euo pipefail

cd "$(dirname "$0")/.."
. deploy/config.sh "$@"
require_project
[ "$PLAN" = 1 ] || require_confirmation

: "${ALERT_CHANNELS:=}"
UPTIME_NAME='Virgil service health'
POLICY_NAME='Virgil service unavailable'

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')
if [ -z "$SERVICE_URL" ]; then
  echo "Cloud Run service ${SERVICE_NAME} has no URL." >&2
  exit 2
fi
HOST=${SERVICE_URL#https://}
HOST=${HOST%/}

UPTIME_RESOURCE=$(gcloud monitoring uptime list-configs --project "$PROJECT_ID" \
  --format='value(name,displayName)' \
  | awk -F '\t' -v wanted="$UPTIME_NAME" '$2 == wanted { print $1; exit }')

echo
echo "public HTTPS health check — three regions, every five minutes"
if [ -n "$UPTIME_RESOURCE" ]; then
  echo "  already exists: ${UPTIME_RESOURCE}"
elif [ "$PLAN" = 1 ]; then
  echo "  would create uptime check '${UPTIME_NAME}' for https://${HOST}/health"
else
  gcloud monitoring uptime create "$UPTIME_NAME" \
    --project "$PROJECT_ID" \
    --resource-type=uptime-url \
    --resource-labels="host=${HOST},project_id=${PROJECT_ID}" \
    --protocol=https \
    --path=/health \
    --request-method=get \
    --status-codes=200 \
    --matcher-type=contains-string \
    --matcher-content='"ok":true' \
    --period=5 \
    --timeout=10 \
    --regions=usa-iowa,europe,asia-pacific \
    --validate-ssl=true \
    --user-labels=product=virgil,role=health
  UPTIME_RESOURCE=$(gcloud monitoring uptime list-configs --project "$PROJECT_ID" \
    --format='value(name,displayName)' \
    | awk -F '\t' -v wanted="$UPTIME_NAME" '$2 == wanted { print $1; exit }')
fi

POLICY_RESOURCE=$(gcloud monitoring policies list --project "$PROJECT_ID" \
  --format='value(name,displayName)' \
  | awk -F '\t' -v wanted="$POLICY_NAME" '$2 == wanted { print $1; exit }')

echo
echo "availability incident — two failed regional checks for ten minutes"
if [ -n "$POLICY_RESOURCE" ]; then
  echo "  already exists: ${POLICY_RESOURCE}"
  if [ -n "$ALERT_CHANNELS" ]; then
    if [ "$PLAN" = 1 ]; then
      echo "  would set the supplied notification channels on the existing policy"
    else
      gcloud monitoring policies update "$POLICY_RESOURCE" \
        --project "$PROJECT_ID" \
        --set-notification-channels="$ALERT_CHANNELS"
    fi
  fi
elif [ "$PLAN" = 1 ]; then
  echo "  would create alert policy '${POLICY_NAME}'"
  if [ -z "$ALERT_CHANNELS" ]; then
    echo "  no ALERT_CHANNELS supplied: incidents would remain in Cloud Monitoring"
  fi
else
  if [ -z "$UPTIME_RESOURCE" ]; then
    echo "The uptime check was not created, so its policy cannot be bound." >&2
    exit 2
  fi
  CHECK_ID=${UPTIME_RESOURCE##*/}
  POLICY_FILE=$(mktemp)
  cleanup() { rm -f "$POLICY_FILE"; }
  trap cleanup EXIT
  CHANNEL_JSON='[]'
  if [ -n "$ALERT_CHANNELS" ]; then
    CHANNEL_JSON=$(printf '%s' "$ALERT_CHANNELS" | awk -F, '{
      printf "[";
      for (i=1;i<=NF;i++) printf "%s\"%s\"", (i>1 ? "," : ""), $i;
      printf "]";
    }')
  fi
  printf '%s\n' '{' \
    "  \"displayName\": \"${POLICY_NAME}\"," \
    '  "combiner": "OR",' \
    '  "enabled": true,' \
    '  "documentation": {' \
    "    \"content\": \"Virgil's public, data-free /health contract has failed. Check Cloud Run revision status, recent ERROR logs, and service/Job release identity before changing traffic.\"," \
    '    "mimeType": "text/markdown"' \
    '  },' \
    "  \"notificationChannels\": ${CHANNEL_JSON}," \
    '  "conditions": [' \
    '    {' \
    "      \"displayName\": \"Two failed checkers for ${CHECK_ID}\"," \
    '      "conditionThreshold": {' \
    '        "aggregations": [' \
    '          {' \
    '            "alignmentPeriod": "1200s",' \
    '            "perSeriesAligner": "ALIGN_NEXT_OLDER",' \
    '            "crossSeriesReducer": "REDUCE_COUNT_FALSE",' \
    '            "groupByFields": ["resource.label.*"]' \
    '          }' \
    '        ],' \
    '        "comparison": "COMPARISON_GT",' \
    '        "duration": "600s",' \
    "        \"filter\": \"metric.type=\\\"monitoring.googleapis.com/uptime_check/check_passed\\\" AND metric.label.check_id=\\\"${CHECK_ID}\\\" AND resource.type=\\\"uptime_url\\\"\"," \
    '        "thresholdValue": 1,' \
    '        "trigger": {"count": 1}' \
    '      }' \
    '    }' \
    '  ],' \
    '  "userLabels": {"product": "virgil", "role": "availability"}' \
    '}' >"$POLICY_FILE"
  gcloud monitoring policies create --project "$PROJECT_ID" \
    --policy-from-file="$POLICY_FILE"
fi

echo
echo "verify:"
echo "  gcloud monitoring uptime list-configs --project ${PROJECT_ID}"
echo "  gcloud monitoring policies list --project ${PROJECT_ID}"
echo "  PROJECT_ID=${PROJECT_ID} ./deploy/audit-live.sh"
