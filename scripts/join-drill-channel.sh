#!/usr/bin/env bash
#
# Invite a Slack user to the most recently created drill war-room channel.
#
# Usage:
#   scripts/join-drill-channel.sh --user U0123ABCD [--env staging|production]
#                                  [--max-age 120]
#
# Why this exists: the bot creates `marshal-p1-*` as PRIVATE channels and is
# the only member. Slack has no UI path for a regular user to self-invite to a
# private channel they aren't in. Rather than bake the drill runner's user ID
# into the ECS task env at deploy time (requires redeploy to change operators),
# this script runs client-side: pulls the bot token from Secrets Manager,
# finds the freshest `marshal-p1-*` channel, calls conversations.invite.
#
# Typical flow:
#   npm run drill:staging
#   scripts/join-drill-channel.sh --user U0123ABCD
#
# Requires: aws CLI (Secrets Manager read), curl, jq.
set -euo pipefail

ENVIRONMENT="staging"
USER_ID="${SLACK_USER_ID:-}"
MAX_AGE_SEC=120
REGION="${AWS_REGION:-us-west-2}"

usage() {
  cat <<EOF
Usage: $0 --user U0123ABCD [--env staging|production] [--max-age 120]

Finds the freshest marshal-p1-* private channel the bot created (within
--max-age seconds, default 120) and invites the given Slack user ID.

You can also export SLACK_USER_ID in your shell and omit --user.

Finding your Slack user ID: click your avatar in Slack → Profile → ⋯ → Copy
member ID. It is a \`U\` followed by ~10 alphanumeric chars.
EOF
  exit "${1:-1}"
}

while (( $# > 0 )); do
  case "$1" in
    --env)      ENVIRONMENT="${2:?}"; shift 2 ;;
    --user)     USER_ID="${2:?}"; shift 2 ;;
    --max-age)  MAX_AGE_SEC="${2:?}"; shift 2 ;;
    --region)   REGION="${2:?}"; shift 2 ;;
    -h|--help)  usage 0 ;;
    *)          printf '[join] unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

case "$ENVIRONMENT" in staging|production) ;; *) printf '[join] --env must be staging or production\n' >&2; exit 1 ;; esac
[[ -n "$USER_ID" ]] || { printf '[join] --user <SlackUserID> required (or export SLACK_USER_ID). Format: U0123ABCD\n' >&2; exit 1; }
[[ "$USER_ID" =~ ^U[A-Z0-9]+$ ]] || { printf '[join] --user must look like a Slack user ID (U...), got: %s\n' "$USER_ID" >&2; exit 1; }
command -v jq >/dev/null || { printf '[join] jq required\n' >&2; exit 1; }

log() { printf '[join] %s\n' "$*"; }
die() { printf '[join] FAIL: %s\n' "$*" >&2; exit 1; }

BOT_TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "marshal/${ENVIRONMENT}/slack/bot-token" \
  --query SecretString --output text 2>/dev/null) \
  || die "could not read marshal/${ENVIRONMENT}/slack/bot-token — is it seeded?"

log "polling for a fresh marshal-p1-* channel (<= ${MAX_AGE_SEC}s old)"

NOW_EPOCH=$(date +%s)
CHANNEL_ID=""
CHANNEL_NAME=""
for attempt in 1 2 3 4 5 6 7 8; do
  RESP=$(curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
    'https://slack.com/api/conversations.list?types=private_channel&limit=200')
  read -r CHANNEL_ID CHANNEL_NAME < <(printf '%s' "$RESP" | jq -r \
    --argjson now "$NOW_EPOCH" --argjson maxage "$MAX_AGE_SEC" '
      .channels // []
      | map(select(.name | startswith("marshal-p1-")))
      | map(select(($now - .created) <= $maxage))
      | sort_by(-.created)
      | .[0] // empty
      | "\(.id) \(.name)"
    ')
  [[ -n "${CHANNEL_ID:-}" ]] && break
  log "attempt $attempt — no fresh channel yet; sleeping 3s"
  sleep 3
done

[[ -n "${CHANNEL_ID:-}" ]] || die "no marshal-p1-* channel created in the last ${MAX_AGE_SEC}s. Did fire-drill.sh return HTTP 200? Processor log: aws logs tail /marshal/${ENVIRONMENT}/processor --region $REGION --since 5m"

log "channel=$CHANNEL_NAME id=$CHANNEL_ID"

RESULT=$(curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-type: application/json; charset=utf-8' \
  -X POST 'https://slack.com/api/conversations.invite' \
  -d "{\"channel\":\"$CHANNEL_ID\",\"users\":\"$USER_ID\"}")

OK=$(printf '%s' "$RESULT" | jq -r '.ok')
ERR=$(printf '%s' "$RESULT" | jq -r '.error // ""')

if [[ "$OK" == "true" ]]; then
  log "invited $USER_ID to $CHANNEL_NAME"
elif [[ "$ERR" == "already_in_channel" ]]; then
  log "$USER_ID is already in $CHANNEL_NAME — nothing to do"
else
  die "invite failed: $RESULT"
fi
