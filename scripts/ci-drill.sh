#!/usr/bin/env bash
#
# CI drill — fire a synthetic P1, assert the assembler wrote the expected
# audit trail, clean up. Designed to be invoked from a nightly GH Actions
# workflow against staging.
#
# Exits non-zero if:
#   - fire-drill.sh didn't return HTTP 200
#   - ROOM_ASSEMBLED didn't appear in DDB within POLL_SEC
#   - the expected audit events are missing
#
# Cleanup (best-effort):
#   - Slack war-room channel is archived via conversations.archive
#   - DDB incident row is deleted (keeps staging tidy for repeated runs)
#
# Required env:
#   AWS_REGION (default us-west-2)
#   ENVIRONMENT (default staging)
#
# Requires: aws CLI with Secrets Manager + CFN + DDB read + DDB delete,
#           curl, jq, openssl (fire-drill.sh's own deps).

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-staging}"
REGION="${AWS_REGION:-us-west-2}"
POLL_SEC="${POLL_SEC:-90}"

INCIDENTS_TABLE="marshal-${ENVIRONMENT}-incidents"
AUDIT_TABLE="marshal-${ENVIRONMENT}-audit"

log() { printf '[ci-drill] %s\n' "$*"; }
die() { printf '[ci-drill] FAIL: %s\n' "$*" >&2; exit 1; }

# Pick a deterministic incident_id so we can query DDB for it cleanly.
INCIDENT_ID="ci-drill-$(date +%s)-${GITHUB_RUN_ID:-local}"
log "incident_id=$INCIDENT_ID region=$REGION env=$ENVIRONMENT"

# ── Fire ────────────────────────────────────────────────────────────────────
bash "$(dirname "$0")/fire-drill.sh" \
  --env "$ENVIRONMENT" --state firing --incident-id "$INCIDENT_ID" --region "$REGION"

# ── Poll for ROOM_ASSEMBLED ────────────────────────────────────────────────
log "polling for ROOM_ASSEMBLED in $INCIDENTS_TABLE (<= ${POLL_SEC}s)"
STATUS=""
CHANNEL_ID=""
for _ in $(seq 1 $((POLL_SEC / 3))); do
  ROW=$(aws dynamodb get-item --region "$REGION" --table-name "$INCIDENTS_TABLE" \
    --key "{\"PK\":{\"S\":\"INCIDENT#$INCIDENT_ID\"},\"SK\":{\"S\":\"METADATA\"}}" \
    --query 'Item' --output json 2>/dev/null || printf '{}')
  STATUS=$(printf '%s' "$ROW" | jq -r '.status.S // empty')
  CHANNEL_ID=$(printf '%s' "$ROW" | jq -r '.slack_channel_id.S // empty')
  if [[ "$STATUS" == "ROOM_ASSEMBLED" && -n "$CHANNEL_ID" ]]; then break; fi
  sleep 3
done

[[ "$STATUS" == "ROOM_ASSEMBLED" ]] || die "incident never reached ROOM_ASSEMBLED (last status='$STATUS')"
[[ -n "$CHANNEL_ID" ]] || die "incident has no slack_channel_id"
log "ROOM_ASSEMBLED | channel_id=$CHANNEL_ID"

# ── Assert the expected audit trail ─────────────────────────────────────────
# Minimum viable trail: WAR_ROOM_CREATED + CONTEXT_SNAPSHOT_ATTACHED + CHECKLIST_PINNED.
REQUIRED_EVENTS=(WAR_ROOM_CREATED CONTEXT_SNAPSHOT_ATTACHED CHECKLIST_PINNED)

AUDIT_EVENTS=$(aws dynamodb query --region "$REGION" --table-name "$AUDIT_TABLE" \
  --key-condition-expression 'PK = :pk' \
  --expression-attribute-values "{\":pk\":{\"S\":\"INCIDENT#$INCIDENT_ID\"}}" \
  --query 'Items[*].action_type.S' --output text 2>/dev/null || true)

log "audit events present: $AUDIT_EVENTS"
for expected in "${REQUIRED_EVENTS[@]}"; do
  if ! printf '%s\n' "$AUDIT_EVENTS" | grep -qw "$expected"; then
    die "expected audit event '$expected' missing for $INCIDENT_ID"
  fi
done
log "audit trail verified (${#REQUIRED_EVENTS[@]} required events present)"

# ── Cleanup (best-effort) ───────────────────────────────────────────────────
# Archive the Slack channel so staging doesn't accumulate drill rooms.
BOT_TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "marshal/${ENVIRONMENT}/slack/bot-token" \
  --query SecretString --output text 2>/dev/null || true)
if [[ -n "$BOT_TOKEN" ]]; then
  ARCHIVE_RESP=$(curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" \
    -H 'Content-type: application/json; charset=utf-8' \
    -d "{\"channel\":\"$CHANNEL_ID\"}" \
    https://slack.com/api/conversations.archive 2>/dev/null || printf '{"ok":false}')
  if [[ "$(printf '%s' "$ARCHIVE_RESP" | jq -r '.ok')" == "true" ]]; then
    log "channel archived: $CHANNEL_ID"
  else
    log "channel archive failed (non-fatal): $(printf '%s' "$ARCHIVE_RESP" | jq -r '.error // "unknown"')"
  fi
fi

# Delete the DDB incident row so the next CI drill doesn't conflict.
# Audit rows stay (366-day TTL handles them) — they're useful for debugging CI
# failures, and each drill has a unique INCIDENT#ci-drill-* PK so no overlap.
aws dynamodb delete-item --region "$REGION" --table-name "$INCIDENTS_TABLE" \
  --key "{\"PK\":{\"S\":\"INCIDENT#$INCIDENT_ID\"},\"SK\":{\"S\":\"METADATA\"}}" >/dev/null 2>&1 \
  && log "incident row deleted" \
  || log "incident row delete failed (non-fatal)"

log "CI drill passed"
