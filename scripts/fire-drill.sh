#!/usr/bin/env bash
#
# Fire a synthetic Grafana OnCall alert at incident-response's webhook Ingress.
#
# Purpose: exercise the full P1 flow end-to-end without needing a real
# Grafana OnCall integration — HMAC-signed with the seeded webhook secret
# so the webhook treats it as a genuine alert.
#
# Usage:
#   scripts/fire-drill.sh [--env development|staging|production]
#                         [--state firing|resolved|silenced]
#                         [--incident-id <id>]
#                         [--title <text>]
#                         [--url <base-url>] [--host <hostname>] [--from-cluster]
#                         [--namespace <ns>] [--region <region>]
#                         [--hmac-secret-id <id>] [--dry-run]
#
# Defaults: --env staging, --state firing, auto-generated incident ID.
#
# Where the webhook URL comes from, highest precedence first:
#   1. --url  / DRILL_WEBHOOK_URL   a full base URL, scheme included, no path
#   2. --host / DRILL_WEBHOOK_HOST  a hostname; the scheme is https
#   3. --from-cluster               the live Ingress, read with kubectl
#   4. chart/values-<env>.yaml      `ingress.host` — the default
#
# The values file is the default because it is the same object ArgoCD renders
# the Ingress from, and reading it needs nothing but a checkout: no kubeconfig,
# no cluster reachability. That is what lets one command work from a laptop and
# from CI, where the drill authenticates to AWS and never to the cluster.
# `--from-cluster` is there for when you want to prove the drill is hitting the
# load balancer that exists rather than the one the chart declares.
#
# The request path comes from `ingress.path` too, so the drill follows the
# listener rule instead of assuming one. (`ingress.healthcheckPath` is the ALB
# target-group probe, not a listener rule — it is not reachable from outside the
# load balancer and is no use as a liveness check from here.)
#
# What it does:
#   1. Resolves the webhook base URL (above) and the routed path
#   2. Reads the HMAC secret from Secrets Manager
#      (incident-response/${env}/grafana/oncall-webhook-hmac), or takes the
#      value straight from DRILL_HMAC_SECRET
#   3. Builds a payload that passes GrafanaOnCallPayloadSchema (Zod)
#   4. Signs with HMAC-SHA256 (hex), header `x-grafana-oncall-signature`
#   5. POSTs to <base-url><ingress.path>/grafana-oncall
#   6. Echoes the HTTP status + incident ID + next-step hints
#
# Side effects on a firing alert:
#   - Creates a Slack private channel (`incident-response-p1-YYYYMMDD-<6char>`)
#   - Writes `incident-response-${env}-incidents` row (status: ALERT_RECEIVED → ROOM_ASSEMBLED)
#   - Writes audit events to `incident-response-${env}-audit`
#   - Schedules a 15-min status-update nudge via EventBridge Scheduler
#   - Attempts to invite responders via OnCall escalation chain + WorkOS
#     directory group lookup (both will return empty for a synthetic
#     `integration_id`/`team_id`, which is fine — the IC handles empty
#     invite lists gracefully via the DIRECTORY_LOOKUP_FAILED audit path)
#
# Requires: openssl, jq, curl — plus the aws CLI with Secrets Manager read,
#           unless DRILL_HMAC_SECRET carries the secret. `--dry-run` resolves
#           the target and builds the payload without contacting anything, so
#           it needs no credentials at all.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENVIRONMENT="staging"
STATE="firing"
INCIDENT_ID=""
TITLE=""
REGION="${AWS_REGION:-us-west-2}"
BASE_URL="${DRILL_WEBHOOK_URL:-}"
HOST="${DRILL_WEBHOOK_HOST:-}"
NAMESPACE="${DRILL_NAMESPACE:-tenants-incident-response}"
HMAC_SECRET_ID="${DRILL_HMAC_SECRET_ID:-}"
FROM_CLUSTER=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $0 [--env development|staging|production] [--state firing|resolved|silenced]
           [--incident-id <id>] [--title <text>]
           [--url <base-url>] [--host <hostname>] [--from-cluster]
           [--namespace <ns>] [--region <region>]
           [--hmac-secret-id <id>] [--dry-run]

See the header of this file for how the webhook URL is resolved and what each
firing produces in your environment.
EOF
  exit "${1:-1}"
}

while (( $# > 0 )); do
  case "$1" in
    --env)            ENVIRONMENT="${2:?}"; shift 2 ;;
    --state)          STATE="${2:?}"; shift 2 ;;
    --incident-id)    INCIDENT_ID="${2:?}"; shift 2 ;;
    --title)          TITLE="${2:?}"; shift 2 ;;
    --url)            BASE_URL="${2:?}"; shift 2 ;;
    --host)           HOST="${2:?}"; shift 2 ;;
    --from-cluster)   FROM_CLUSTER=1; shift ;;
    --namespace)      NAMESPACE="${2:?}"; shift 2 ;;
    --region)         REGION="${2:?}"; shift 2 ;;
    --hmac-secret-id) HMAC_SECRET_ID="${2:?}"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -h|--help)        usage 0 ;;
    *)                printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

case "$ENVIRONMENT" in development|staging|production) ;; *) printf '[drill] --env must be development, staging, or production\n' >&2; exit 1 ;; esac
case "$STATE" in firing|resolved|silenced) ;; *) printf '[drill] --state must be firing, resolved, or silenced\n' >&2; exit 1 ;; esac
command -v openssl >/dev/null || { printf '[drill] openssl required\n' >&2; exit 1; }
command -v jq      >/dev/null || { printf '[drill] jq required\n' >&2; exit 1; }
command -v curl    >/dev/null || { printf '[drill] curl required\n' >&2; exit 1; }

[[ -z "$INCIDENT_ID" ]] && INCIDENT_ID="drill-$(date +%s)-$$"
[[ -z "$TITLE" ]] && TITLE="DRILL: synthetic P1 — do not page"

log() { printf '[drill] %s\n' "$*"; }
die() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }

BASE_VALUES="$REPO_ROOT/chart/values.yaml"
ENV_VALUES="$REPO_ROOT/chart/values-${ENVIRONMENT}.yaml"

# Read `<block>.<key>` out of a Helm values file. Everything read here sits one
# level under a top-level block in hand-written, two-space-indented YAML with no
# anchors, lists, or multi-line scalars — so a targeted awk beats taking a
# dependency on yq, which a CI runner and a fresh laptop do not both carry.
# Prints nothing when the key is absent or set to an empty string.
values_get() {
  local file="$1" block="$2" key="$3" raw
  [[ -f "$file" ]] || return 0
  raw=$(awk -v block="$block" -v key="$key" '
    /^[^ \t#]/ { inblock = ($0 == block":") }
    inblock && index($0, "  " key ":") == 1 {
      sub("^  " key ":[ \t]*", "")
      sub("[ \t]+#.*$", "")
      sub("[ \t]+$", "")
      print
      exit
    }
  ' "$file")
  raw="${raw%\'}"; raw="${raw#\'}"
  raw="${raw%\"}"; raw="${raw#\"}"
  printf '%s' "$raw"
}

# Per-env file wins, base file is the fallback — the same precedence Helm applies
# to the two `valueFiles` in gitops/applicationset-entry.yaml.
values_lookup() {
  local v
  v=$(values_get "$ENV_VALUES" "$1" "$2")
  [[ -n "$v" ]] || v=$(values_get "$BASE_VALUES" "$1" "$2")
  printf '%s' "$v"
}

# ── Resolve the webhook target ───────────────────────────────────────────────
if [[ -n "$BASE_URL" ]]; then
  SOURCE="--url / DRILL_WEBHOOK_URL"
elif [[ -n "$HOST" ]]; then
  SOURCE="--host / DRILL_WEBHOOK_HOST"
elif (( FROM_CLUSTER == 1 )); then
  command -v kubectl >/dev/null || die "--from-cluster needs kubectl on PATH"
  HOST=$(kubectl -n "$NAMESPACE" get ingress -l incident-response.io/service=webhook \
    -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
  [[ -n "$HOST" ]] || die "no webhook Ingress in namespace $NAMESPACE — is the chart deployed to the cluster your kubeconfig points at?"
  SOURCE="live Ingress in $NAMESPACE"
else
  HOST=$(values_lookup ingress host)
  [[ -n "$HOST" ]] || die "ingress.host is empty in chart/values-${ENVIRONMENT}.yaml — set it, pass --host/--url, or use --from-cluster"
  SOURCE="chart/values-${ENVIRONMENT}.yaml"
fi

# `example.com` is the placeholder this repository ships so the chart renders
# without naming anyone's DNS zone. It resolves to a parked IANA address, so
# firing at it would hang rather than fail — name it instead.
case "$HOST" in
  example.com|*.example.com)
    die "ingress.host in chart/values-${ENVIRONMENT}.yaml is still the placeholder '$HOST'. Set it to the hostname external-dns published for the ALB, pass --host <hostname> or --url <base-url>, or use --from-cluster." ;;
esac

[[ -n "$BASE_URL" ]] || BASE_URL="https://${HOST}"
BASE_URL="${BASE_URL%/}"

INGRESS_PATH=$(values_lookup ingress path)
[[ -n "$INGRESS_PATH" ]] || die "ingress.path is empty in the chart values — nothing tells the load balancer where to route the webhook"
INGRESS_PATH="${INGRESS_PATH%/}"
TARGET="${BASE_URL}${INGRESS_PATH}/grafana-oncall"

log "env=$ENVIRONMENT state=$STATE region=$REGION"
log "webhook_url=$TARGET (resolved from $SOURCE)"
log "incident_id=$INCIDENT_ID"

# ── HMAC secret ──────────────────────────────────────────────────────────────
[[ -n "$HMAC_SECRET_ID" ]] || HMAC_SECRET_ID="incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac"
HMAC_SECRET="${DRILL_HMAC_SECRET:-}"

if [[ -z "$HMAC_SECRET" ]]; then
  if (( DRY_RUN == 1 )); then
    log "dry run: skipping the Secrets Manager read of $HMAC_SECRET_ID (set DRILL_HMAC_SECRET to sign anyway)"
  else
    command -v aws >/dev/null || die "aws CLI required to read $HMAC_SECRET_ID — install it, or pass the value in DRILL_HMAC_SECRET"
    HMAC_SECRET=$(aws secretsmanager get-secret-value --region "$REGION" \
      --secret-id "$HMAC_SECRET_ID" \
      --query 'SecretString' --output text 2>/dev/null || true)
    [[ -n "$HMAC_SECRET" ]] || die "could not read $HMAC_SECRET_ID in $REGION — has it been seeded? (npm run seed:${ENVIRONMENT})"
  fi
fi

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
SIGNATURE=""
if [[ -n "$HMAC_SECRET" ]]; then
  SIGNATURE=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | sed 's/^.*= //')
fi

if (( DRY_RUN == 1 )); then
  log "dry run — nothing sent"
  log "  POST   $TARGET"
  log "  header x-grafana-oncall-signature: ${SIGNATURE:-<unsigned: no secret resolved>}"
  log "  hmac   $HMAC_SECRET_ID"
  log "  body   $PAYLOAD"
  exit 0
fi

# ── POST ────────────────────────────────────────────────────────────────────
log "POST ${INGRESS_PATH}/grafana-oncall (state=$STATE)"
RESP_FILE=$(mktemp -t incident-response-drill.XXXXXX)
trap 'rm -f "$RESP_FILE"' EXIT
# A transport failure (DNS, TLS, timeout) exits curl non-zero with `000` on
# stdout. Catch it here so the case below can say something useful instead of
# `set -e` killing the script with no explanation.
STATUS=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' --max-time 10 \
  -H 'Content-Type: application/json' \
  -H "x-grafana-oncall-signature: $SIGNATURE" \
  -d "$PAYLOAD" \
  "$TARGET") || STATUS="000"

printf '[drill] HTTP %s\n' "$STATUS"
printf '[drill] body: '; cat "$RESP_FILE"; printf '\n'

case "$STATUS" in
  200)
    log "accepted — webhook ingress queued the event to SQS"
    log ""
    log "What to watch next:"
    log "  • Slack: look for a new private channel named incident-response-p1-* (check recent channels)"
    log "  • State: bash scripts/observe-incident.sh --env $ENVIRONMENT --incident-id $INCIDENT_ID"
    log "  • Logs:  kubectl -n $NAMESPACE logs deploy/incident-response-processor --follow"
    log "  • Audit: aws dynamodb query --region $REGION --table-name incident-response-$ENVIRONMENT-audit \\"
    log "             --key-condition-expression 'PK = :pk' \\"
    log "             --expression-attribute-values '{\":pk\":{\"S\":\"INCIDENT#$INCIDENT_ID\"}}' \\"
    log "             --query 'Items[*].[timestamp.S,action_type.S]' --output table"
    log ""
    log "When you're done with this drill:"
    log "  bash scripts/fire-drill.sh --env $ENVIRONMENT --state resolved --incident-id $INCIDENT_ID"
    ;;
  401) die "signature rejected — the webhook caches the HMAC secret for 5 minutes keyed on its VersionId. If you just rotated it, wait for the TTL or restart: kubectl -n $NAMESPACE rollout restart deploy/incident-response-webhook" ;;
  400) die "Zod payload rejected — the schema changed; update the jq block above" ;;
  404) die "the load balancer did not route ${INGRESS_PATH}/grafana-oncall — only ingress.path and ingress.slackPath get listener rules, so check the path matches the chart values" ;;
  5??) die "webhook error — check: kubectl -n $NAMESPACE logs deploy/incident-response-webhook --since=10m" ;;
  000) die "no response from $TARGET — DNS, TLS, or the load balancer. Check the record external-dns published: dig +short ${HOST:-<host from --url>}" ;;
  *)   die "unexpected status $STATUS" ;;
esac
