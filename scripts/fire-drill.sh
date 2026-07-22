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
#                         [--hmac-secret-id <id>] [--dry-run] [--print-host]
#
# Defaults: --env staging, --state firing, auto-generated incident ID.
#
# Where the webhook URL comes from, highest precedence first:
#   1. --url  <base-url>          a full base URL, scheme included, no path
#   2. --host <hostname>          a hostname; the scheme is https
#   3. DRILL_WEBHOOK_URL_<ENV>    the same as --url, for that environment only
#   4. DRILL_WEBHOOK_HOST_<ENV>   the same as --host, for that environment only
#   5. --from-cluster             the live Ingress, read with kubectl
#   6. chart/values-<env>.yaml    `ingress.host` — the default
#
# The values file is the default because it is the same object ArgoCD renders
# the Ingress from, and reading it needs nothing but a checkout: no kubeconfig,
# no cluster reachability. That is what lets one command work from a laptop and
# from CI, where the drill authenticates to AWS and never to the cluster.
# `--from-cluster` is there for when you want to prove the drill is hitting the
# load balancer that exists rather than the one the chart declares.
#
# ── Signature and destination stay in the same environment ──────────────────
#
# A drill signs with `incident-response/<env>/grafana/oncall-webhook-hmac`, so a
# target resolved for one environment and signed for another is a production
# secret delivered to a staging load balancer. Three rules make that
# unrepresentable, checked before anything is signed or sent:
#
#   1. Overrides are environment-scoped. An unscoped DRILL_WEBHOOK_HOST or
#      DRILL_WEBHOOK_URL is refused by name, not ignored — one variable that
#      applies to every `--env` is exactly how the misfire happens, and a
#      caller who set it deserves to be told rather than silently overruled.
#   2. A resolved host that is another environment's `ingress.host` is refused,
#      whichever way it was resolved.
#   3. Once `chart/values-<env>.yaml` names a real host, that host is the
#      environment's identity: an explicit override that disagrees with it is
#      refused. Change the values file, or use `--from-cluster`.
#
# `--print-host` prints the resolved hostname and exits, after all three checks.
# It is the hook a caller uses to assert the target independently — the drill
# workflow derives the expected host from its own configuration and compares.
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
BASE_URL=""
HOST=""
NAMESPACE="${DRILL_NAMESPACE:-tenants-incident-response}"
HMAC_SECRET_ID="${DRILL_HMAC_SECRET_ID:-}"
FROM_CLUSTER=0
DRY_RUN=0
PRINT_HOST=0

usage() {
  cat <<EOF
Usage: $0 [--env development|staging|production] [--state firing|resolved|silenced]
           [--incident-id <id>] [--title <text>]
           [--url <base-url>] [--host <hostname>] [--from-cluster]
           [--namespace <ns>] [--region <region>]
           [--hmac-secret-id <id>] [--dry-run] [--print-host]

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
    --print-host)     PRINT_HOST=1; shift ;;
    -h|--help)        usage 0 ;;
    *)                printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

case "$ENVIRONMENT" in development|staging|production) ;; *) printf '[drill] --env must be development, staging, or production\n' >&2; exit 1 ;; esac
case "$STATE" in firing|resolved|silenced) ;; *) printf '[drill] --state must be firing, resolved, or silenced\n' >&2; exit 1 ;; esac
# `--print-host` resolves and checks the target and prints nothing else, so it
# needs none of the payload tooling. Everything else does.
if (( PRINT_HOST == 0 )); then
  command -v openssl >/dev/null || { printf '[drill] openssl required\n' >&2; exit 1; }
  command -v jq      >/dev/null || { printf '[drill] jq required\n' >&2; exit 1; }
  command -v curl    >/dev/null || { printf '[drill] curl required\n' >&2; exit 1; }
fi

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

ENVIRONMENTS=(development staging production)
ENV_UPPER=$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')

# `example.com` is the placeholder this repository ships so the chart renders
# without naming anyone's DNS zone. It resolves to a parked IANA address, so
# firing at it would hang rather than fail. A placeholder is also not an
# identity, so it never counts as an environment's declared host below.
is_placeholder_host() {
  case "$1" in ''|example.com|*.example.com) return 0 ;; *) return 1 ;; esac
}

# Hostname out of a base URL: drop the scheme, the path, and any port.
host_from_url() {
  local rest="${1#*://}"
  rest="${rest%%/*}"
  printf '%s' "${rest%%:*}"
}

# `ingress.host` as the named environment declares it. Empty when that
# environment has no values file, which is how a partial fork looks.
declared_host() {
  values_get "$REPO_ROOT/chart/values-${1}.yaml" ingress host
}

# ── Refuse unscoped overrides ────────────────────────────────────────────────
# A single DRILL_WEBHOOK_HOST applies to every --env, so a caller who exports it
# for staging silently redirects the next production drill — which still signs
# with the production HMAC secret. Name the problem instead of overruling it.
for unscoped in DRILL_WEBHOOK_URL DRILL_WEBHOOK_HOST; do
  if [[ -n "${!unscoped:-}" ]]; then
    die "$unscoped is set, and it applies to every --env. Use the environment-scoped name instead: ${unscoped}_${ENV_UPPER} (and ${unscoped}_DEVELOPMENT / ${unscoped}_STAGING / ${unscoped}_PRODUCTION for the others). The drill signs with incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac, so one variable shared across environments delivers one environment's signature to another's load balancer."
  fi
done

# ── Resolve the webhook target ───────────────────────────────────────────────
# OVERRIDDEN marks the paths that name a target from outside the chart. Those
# are the ones checked against the environment's declared host below; the values
# file and the live Ingress are not overrides of anything.
SCOPED_URL_VAR="DRILL_WEBHOOK_URL_${ENV_UPPER}"
SCOPED_HOST_VAR="DRILL_WEBHOOK_HOST_${ENV_UPPER}"
OVERRIDDEN=0

if [[ -n "$BASE_URL" ]]; then
  SOURCE="--url"; OVERRIDDEN=1
elif [[ -n "$HOST" ]]; then
  SOURCE="--host"; OVERRIDDEN=1
elif [[ -n "${!SCOPED_URL_VAR:-}" ]]; then
  BASE_URL="${!SCOPED_URL_VAR}"; SOURCE="$SCOPED_URL_VAR"; OVERRIDDEN=1
elif [[ -n "${!SCOPED_HOST_VAR:-}" ]]; then
  HOST="${!SCOPED_HOST_VAR}"; SOURCE="$SCOPED_HOST_VAR"; OVERRIDDEN=1
elif (( FROM_CLUSTER == 1 )); then
  command -v kubectl >/dev/null || die "--from-cluster needs kubectl on PATH"
  HOST=$(kubectl -n "$NAMESPACE" get ingress -l incident-response.io/service=webhook \
    -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
  [[ -n "$HOST" ]] || die "no webhook Ingress in namespace $NAMESPACE — is the chart deployed to the cluster your kubeconfig points at?"
  SOURCE="live Ingress in $NAMESPACE"
else
  HOST=$(values_lookup ingress host)
  [[ -n "$HOST" ]] || die "ingress.host is empty in chart/values-${ENVIRONMENT}.yaml — set it, pass --host/--url, set ${SCOPED_HOST_VAR}, or use --from-cluster"
  SOURCE="chart/values-${ENVIRONMENT}.yaml"
fi

# Every path lands on a hostname, including --url, so one set of checks covers
# all of them.
[[ -n "$HOST" ]] || HOST=$(host_from_url "$BASE_URL")
[[ -n "$HOST" ]] || die "no hostname in the base URL from $SOURCE — pass a URL with a scheme and a host, like https://webhook.example-corp.io"

if is_placeholder_host "$HOST"; then
  die "$SOURCE resolves to the placeholder host '$HOST'. Set chart/values-${ENVIRONMENT}.yaml's ingress.host to the hostname external-dns published for the ALB, pass --host <hostname> or --url <base-url>, set ${SCOPED_HOST_VAR}, or use --from-cluster."
fi

# ── Keep the signature and the destination in the same environment ───────────
# The drill signs with this environment's HMAC secret. Both checks below run
# before a payload is built, so a cross-environment target never reaches the
# signing step, let alone the network.
DECLARED_HOST=$(declared_host "$ENVIRONMENT")

for other_env in "${ENVIRONMENTS[@]}"; do
  [[ "$other_env" == "$ENVIRONMENT" ]] && continue
  other_host=$(declared_host "$other_env")
  is_placeholder_host "$other_host" && continue
  if [[ "$HOST" == "$other_host" ]]; then
    die "refusing to fire: --env $ENVIRONMENT signs with incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac, but $SOURCE resolves to '$HOST', which chart/values-${other_env}.yaml declares as the $other_env webhook host. Drill $other_env with --env $other_env."
  fi
done

if (( OVERRIDDEN == 1 )) && ! is_placeholder_host "$DECLARED_HOST" && [[ "$HOST" != "$DECLARED_HOST" ]]; then
  die "refusing to fire: chart/values-${ENVIRONMENT}.yaml declares the $ENVIRONMENT webhook host as '$DECLARED_HOST', but $SOURCE resolves to '$HOST'. Once the values file names a real host it is what ArgoCD renders the Ingress from and what this environment is; change it there, or use --from-cluster to drill whatever the cluster actually serves."
fi

if (( FROM_CLUSTER == 1 )) && ! is_placeholder_host "$DECLARED_HOST" && [[ "$HOST" != "$DECLARED_HOST" ]]; then
  log "WARNING: the live Ingress in $NAMESPACE serves '$HOST'; chart/values-${ENVIRONMENT}.yaml declares '$DECLARED_HOST'. Firing at the live one — the chart and the cluster have drifted."
fi

[[ -n "$BASE_URL" ]] || BASE_URL="https://${HOST}"
BASE_URL="${BASE_URL%/}"

INGRESS_PATH=$(values_lookup ingress path)
[[ -n "$INGRESS_PATH" ]] || die "ingress.path is empty in the chart values — nothing tells the load balancer where to route the webhook"
INGRESS_PATH="${INGRESS_PATH%/}"
TARGET="${BASE_URL}${INGRESS_PATH}/grafana-oncall"

# Resolution and the environment checks are done. Callers that only want to know
# where a drill would land get the hostname on stdout and nothing else.
if (( PRINT_HOST == 1 )); then
  printf '%s\n' "$HOST"
  exit 0
fi

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
