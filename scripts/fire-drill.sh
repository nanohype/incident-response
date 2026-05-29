#!/usr/bin/env bash
#
# Fire a synthetic Grafana OnCall alert at Marshal's webhook ingress.
#
# Purpose: exercise the full P1 flow end-to-end without needing a real
# Grafana OnCall integration — HMAC-signed with the seeded webhook secret
# so the Lambda treats it as a genuine alert.
#
# Usage:
#   scripts/fire-drill.sh [--env staging|production]
#                         [--state firing|resolved|silenced]
#                         [--incident-id <id>]
#                         [--title <text>]
#
# Defaults: --env staging, --state firing, auto-generated incident ID.
#
# What it does:
#   1. Reads the webhook URL from the stack's CFN outputs
#   2. Reads the HMAC secret from Secrets Manager
#      (marshal/${env}/grafana/oncall-webhook-hmac)
#   3. Builds a payload that passes GrafanaOnCallPayloadSchema (Zod)
#   4. Signs with HMAC-SHA256 (hex), header `x-grafana-oncall-signature`
#   5. POSTs to <WebhookApiUrl>/webhook/grafana-oncall
#   6. Echoes the HTTP status + incident ID + next-step hints
#
# Side effects on a firing alert:
#   - Creates a Slack private channel (`marshal-p1-YYYYMMDD-<6char>`)
#   - Writes `marshal-${env}-incidents` row (status: ALERT_RECEIVED → ROOM_ASSEMBLED)
#   - Writes audit events to `marshal-${env}-audit`
#   - Schedules a 15-min status-update nudge via EventBridge Scheduler
#   - Attempts to invite responders via OnCall escalation chain + WorkOS
#     directory group lookup (both will return empty for a synthetic
#     `integration_id`/`team_id`, which is fine — the IC handles empty
#     invite lists gracefully via the DIRECTORY_LOOKUP_FAILED audit path)
#
# Requires: aws CLI (profile with CFN describe + Secrets Manager read),
#           openssl, jq, curl.
set -euo pipefail

ENVIRONMENT="staging"
STATE="firing"
INCIDENT_ID=""
TITLE=""
REGION="${AWS_REGION:-us-west-2}"

usage() {
  cat <<EOF
Usage: $0 [--env staging|production] [--state firing|resolved|silenced]
           [--incident-id <id>] [--title <text>]

See the header of this file for what each firing produces in your stack.
EOF
  exit "${1:-1}"
}

while (( $# > 0 )); do
  case "$1" in
    --env)         ENVIRONMENT="${2:?}"; shift 2 ;;
    --state)       STATE="${2:?}"; shift 2 ;;
    --incident-id) INCIDENT_ID="${2:?}"; shift 2 ;;
    --title)       TITLE="${2:?}"; shift 2 ;;
    --region)      REGION="${2:?}"; shift 2 ;;
    -h|--help)     usage 0 ;;
    *)             printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

case "$ENVIRONMENT" in staging|production) ;; *) printf '[drill] --env must be staging or production\n' >&2; exit 1 ;; esac
case "$STATE" in firing|resolved|silenced) ;; *) printf '[drill] --state must be firing, resolved, or silenced\n' >&2; exit 1 ;; esac
command -v openssl >/dev/null || { printf '[drill] openssl required\n' >&2; exit 1; }
command -v jq      >/dev/null || { printf '[drill] jq required\n' >&2; exit 1; }

STACK_NAME="Marshal${ENVIRONMENT^}"                       # MarshalStaging / MarshalProduction
[[ -z "$INCIDENT_ID" ]] && INCIDENT_ID="drill-$(date +%s)-$$"
[[ -z "$TITLE" ]] && TITLE="DRILL: synthetic P1 — do not page"

log() { printf '[drill] %s\n' "$*"; }
die() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }

# ── Stack outputs ────────────────────────────────────────────────────────────
log "stack=$STACK_NAME region=$REGION env=$ENVIRONMENT state=$STATE"
WEBHOOK_URL=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookApiUrl'].OutputValue" --output text 2>/dev/null || true)
[[ -n "$WEBHOOK_URL" && "$WEBHOOK_URL" != "None" ]] || die "WebhookApiUrl not found — is $STACK_NAME deployed?"

# ── HMAC secret ──────────────────────────────────────────────────────────────
HMAC_SECRET=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "marshal/${ENVIRONMENT}/grafana/oncall-webhook-hmac" \
  --query 'SecretString' --output text 2>/dev/null || true)
[[ -n "$HMAC_SECRET" ]] || die "could not read marshal/${ENVIRONMENT}/grafana/oncall-webhook-hmac — has it been seeded?"

# ── Payload — must match GrafanaOnCallPayloadSchema (src/types/index.ts) ─────
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
PAYLOAD=$(jq -cn \
  --arg id "$INCIDENT_ID" \
  --arg title "$TITLE" \
  --arg state "$STATE" \
  --arg now "$NOW" \
  --arg env "$ENVIRONMENT" \
  '{
    alert_group_id: $id,
    alert_group:    { id: $id, title: $title, state: $state },
    integration_id: "drill-integration-\($env)",
    route_id:       "drill-route-\($env)",
    team_id:        "drill-team",
    team_name:      "Drill Team",
    labels:         { drill: "true", severity: "P1", environment: $env },
    alerts: [{
      id:          "\($id)-alert-1",
      title:       $title,
      message:     "Synthetic P1 fired by scripts/fire-drill.sh at \($now). No action required.",
      received_at: $now
    }]
  }')

# ── Sign (hex HMAC-SHA256, matches webhook-ingress.ts verifyHmacSignature) ──
# macOS/Linux portable: openssl dgst -hex outputs `SHA2-256(stdin)= <hex>`.
# The sed strip isolates the hex digest.
SIGNATURE=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | sed 's/^.*= //')

# ── POST ────────────────────────────────────────────────────────────────────
log "webhook_url=$WEBHOOK_URL"
log "incident_id=$INCIDENT_ID"
log "POST /webhook/grafana-oncall (state=$STATE)"
RESP_FILE=$(mktemp -t marshal-drill.XXXXXX)
trap 'rm -f "$RESP_FILE"' EXIT
STATUS=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' --max-time 10 \
  -H 'Content-Type: application/json' \
  -H "x-grafana-oncall-signature: $SIGNATURE" \
  -d "$PAYLOAD" \
  "${WEBHOOK_URL}/webhook/grafana-oncall")

printf '[drill] HTTP %s\n' "$STATUS"
printf '[drill] body: '; cat "$RESP_FILE"; printf '\n'

case "$STATUS" in
  200)
    log "accepted — webhook ingress queued the event to SQS"
    log ""
    log "What to watch next:"
    log "  • Slack: look for a new private channel named marshal-p1-* (check recent channels)"
    log "  • State: bash scripts/observe-incident.sh --env $ENVIRONMENT --incident-id $INCIDENT_ID"
    log "  • Logs:  aws logs tail /marshal/$ENVIRONMENT/processor --region $REGION --follow"
    log "  • Audit: aws dynamodb query --region $REGION --table-name marshal-$ENVIRONMENT-audit \\"
    log "             --key-condition-expression 'PK = :pk' \\"
    log "             --expression-attribute-values '{\":pk\":{\"S\":\"INCIDENT#$INCIDENT_ID\"}}' \\"
    log "             --query 'Items[*].[timestamp.S,action_type.S]' --output table"
    log ""
    log "When you're done with this drill:"
    log "  bash scripts/fire-drill.sh --env $ENVIRONMENT --state resolved --incident-id $INCIDENT_ID"
    ;;
  401) die "signature rejected — is the HMAC secret the same one Marshal's Lambda caches? Try forcing a new Lambda cold start (update-function-configuration)." ;;
  400) die "Zod payload rejected — the schema changed; update the jq block above" ;;
  5??) die "Lambda error — check /aws/lambda/marshal-${ENVIRONMENT}-ingress" ;;
  *)   die "unexpected status $STATUS" ;;
esac
