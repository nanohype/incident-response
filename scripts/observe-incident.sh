#!/usr/bin/env bash
#
# Snapshot the current state of a Marshal incident across DynamoDB + SQS.
# Designed to be re-run by the operator after each meaningful step — the
# shape of the output doesn't change, so you can compare runs visually.
#
# Usage:
#   scripts/observe-incident.sh [--env staging|production]
#                               --incident-id <id>
#
# Or, to see the most recent drill incident in this environment:
#   scripts/observe-incident.sh --env staging --latest
#
# For a live tail of the processor's stderr, run in another pane:
#   aws logs tail /marshal/staging/processor --region us-west-2 --follow
#
# Requires: aws CLI, jq.
set -euo pipefail

ENVIRONMENT="staging"
INCIDENT_ID=""
LATEST=0
REGION="${AWS_REGION:-us-west-2}"

while (( $# > 0 )); do
  case "$1" in
    --env)         ENVIRONMENT="${2:?}"; shift 2 ;;
    --incident-id) INCIDENT_ID="${2:?}"; shift 2 ;;
    --latest)      LATEST=1; shift ;;
    --region)      REGION="${2:?}"; shift 2 ;;
    -h|--help)     printf 'Usage: %s [--env staging|production] [--incident-id <id> | --latest]\n' "$0"; exit 0 ;;
    *)             printf 'unknown flag: %s\n' "$1" >&2; exit 1 ;;
  esac
done

INCIDENTS_TABLE="marshal-${ENVIRONMENT}-incidents"
AUDIT_TABLE="marshal-${ENVIRONMENT}-audit"
INCIDENT_QUEUE_NAME="marshal-${ENVIRONMENT}-incident-events.fifo"
DLQ_NAME="marshal-${ENVIRONMENT}-incident-events-dlq.fifo"

# ── Resolve --latest ────────────────────────────────────────────────────────
if (( LATEST == 1 )); then
  # Scan is fine for a drill table; production would use the incident-id GSI.
  INCIDENT_ID=$(aws dynamodb scan --region "$REGION" --table-name "$INCIDENTS_TABLE" \
    --projection-expression 'incident_id, created_at' \
    --query 'reverse(sort_by(Items, &created_at.S))[0].incident_id.S' --output text 2>/dev/null || true)
  [[ -n "$INCIDENT_ID" && "$INCIDENT_ID" != "None" ]] || { printf '[observe] no incidents in %s\n' "$INCIDENTS_TABLE" >&2; exit 1; }
fi
[[ -n "$INCIDENT_ID" ]] || { printf '[observe] --incident-id or --latest required\n' >&2; exit 1; }

printf '\n=== incident %s (env=%s) ===\n' "$INCIDENT_ID" "$ENVIRONMENT"

# ── Incident record ─────────────────────────────────────────────────────────
printf '\n── state (marshal-%s-incidents) ────────────────────────\n' "$ENVIRONMENT"
aws dynamodb get-item --region "$REGION" --table-name "$INCIDENTS_TABLE" \
  --key "{\"PK\":{\"S\":\"INCIDENT#${INCIDENT_ID}\"},\"SK\":{\"S\":\"METADATA\"}}" \
  --query 'Item.{status:status.S,severity:severity.S,channel:slack_channel_name.S,channel_id:slack_channel_id.S,responders:responders.L[].S,created:created_at.S,updated:updated_at.S}' \
  --output table 2>&1 | sed 's/^/  /' || printf '  (not found — processor may still be starting)\n'

# ── Audit trail ─────────────────────────────────────────────────────────────
printf '\n── audit trail (marshal-%s-audit) ──────────────────────\n' "$ENVIRONMENT"
aws dynamodb query --region "$REGION" --table-name "$AUDIT_TABLE" \
  --key-condition-expression 'PK = :pk' \
  --expression-attribute-values "{\":pk\":{\"S\":\"INCIDENT#${INCIDENT_ID}\"}}" \
  --projection-expression 'action_type, #ts, actor_user_id' \
  --expression-attribute-names '{"#ts":"timestamp"}' \
  --query 'Items[*].[#ts.S,action_type.S,actor_user_id.S]' \
  --output text 2>/dev/null \
  | awk 'BEGIN{printf "  %-28s  %-32s  %s\n", "timestamp", "action_type", "actor"; printf "  %-28s  %-32s  %s\n", "---------", "-----------", "-----"} {printf "  %-28s  %-32s  %s\n", $1, $2, $3}'

# ── Queue depths ────────────────────────────────────────────────────────────
queue_depth() {
  local name="$1"
  local url
  url=$(aws sqs get-queue-url --region "$REGION" --queue-name "$name" --query 'QueueUrl' --output text 2>/dev/null || true)
  [[ -n "$url" && "$url" != "None" ]] || { printf 'missing'; return; }
  aws sqs get-queue-attributes --region "$REGION" --queue-url "$url" \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' --output text 2>/dev/null
}
printf '\n── queue depths ────────────────────────────────────────\n'
printf '  incident queue: %s\n' "$(queue_depth "$INCIDENT_QUEUE_NAME")"
printf '  dead-letter:    %s  (must stay 0 in a healthy system)\n' "$(queue_depth "$DLQ_NAME")"

# ── Log tail hint ───────────────────────────────────────────────────────────
printf '\n── live logs (run in another pane) ─────────────────────\n'
printf '  aws logs tail /marshal/%s/processor --region %s --follow --filter-pattern "%s"\n' "$ENVIRONMENT" "$REGION" "$INCIDENT_ID"
printf '\n'
