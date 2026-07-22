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
#                         [--canonical-host <value>]
#
# Defaults: --env staging, --state firing, auto-generated incident ID.
#
# ── One target, resolved once ───────────────────────────────────────────────
#
# A drill is a pair: a signing identity — this environment's HMAC secret — and a
# destination. Sign for one environment and deliver to another and a production
# signature lands on a staging load balancer.
#
# So the drill resolves exactly one target URL, and everything downstream reads
# that one value: the environment checks, `--print-host`, and the POST. The
# hostname the checks inspect is derived from that URL rather than carried
# beside it, so there is no second variable a request can be sent to instead.
#
# Ways to name the target. Naming it twice is an error rather than a precedence
# puzzle, because two inputs that disagree are exactly the pair that misfires:
#
#   --url <base-url>          a full base URL, scheme included, no path
#   --host <hostname>         a hostname, optionally with a port; scheme https
#   DRILL_WEBHOOK_URL_<ENV>   the same as --url, for that environment only
#   DRILL_WEBHOOK_HOST_<ENV>  the same as --host, for that environment only
#   --from-cluster            the live Ingress, read with kubectl
#
# Name none of them and the target is `ingress.host` from
# chart/values-<env>.yaml. The values file is the default because it is the same
# object ArgoCD renders the Ingress from, and reading it needs nothing but a
# checkout: no kubeconfig, no cluster reachability. That is what lets one command
# work from a laptop and from CI, where the drill authenticates to AWS and never
# to the cluster. `--from-cluster` is there for when you want to prove the drill
# is hitting the load balancer that exists rather than the one the chart
# declares.
#
# ── Signature and destination stay in the same environment ──────────────────
#
# Five rules, all checked before anything is signed or sent:
#
#   1. The target is named once. Two inputs that name it are refused with both
#      names, whether or not they agree.
#   2. Overrides are environment-scoped. An unscoped DRILL_WEBHOOK_URL,
#      DRILL_WEBHOOK_HOST, DRILL_HMAC_SECRET_ID or DRILL_HMAC_SECRET is refused
#      by name, not ignored — one variable that applies to every `--env` is
#      exactly how the misfire happens, and a caller who set it deserves to be
#      told rather than silently overruled.
#   3. A resolved host that is another environment's `ingress.host` is refused,
#      whichever way it was resolved. Hosts are compared canonically: a scheme,
#      a port, a path, letter case and a trailing root dot can all differ while
#      naming the same load balancer, so none of them survives the comparison.
#   4. Once `chart/values-<env>.yaml` names a real host, that host is the
#      environment's identity: an explicit override that disagrees with it is
#      refused. Change the values file, or use `--from-cluster`.
#   5. The secret the drill signs with belongs to `--env`. A secret id naming
#      another environment's tree is refused for the same reason a host is.
#
# `--print-host` prints the canonical hostname of the request the drill would
# send, and exits, after all five. It is the hook a caller uses to assert the
# target independently — the drill workflow derives the expected host from its
# own configuration and compares.
#
# `--canonical-host <value>` prints the comparison form of a hostname or a base
# URL and exits, and prints nothing at all for the placeholder host this
# repository ships. It is the same primitive rules 3 and 4 compare with, exposed
# so a caller can check `--print-host` against its own configuration without
# restating the rule in a second language.
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
#      value straight from DRILL_HMAC_SECRET_<ENV>
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
#           unless DRILL_HMAC_SECRET_<ENV> carries the secret. `--dry-run`
#           resolves the target and builds the payload without contacting
#           anything, so it needs no credentials at all.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENVIRONMENT="staging"
STATE="firing"
INCIDENT_ID=""
TITLE=""
REGION="${AWS_REGION:-us-west-2}"
URL_FLAG=""
HOST_FLAG=""
NAMESPACE="${DRILL_NAMESPACE:-tenants-incident-response}"
HMAC_SECRET_ID_FLAG=""
FROM_CLUSTER=0
DRY_RUN=0
PRINT_HOST=0
CANONICALIZE=0
CANONICAL_INPUT=""

usage() {
  cat <<EOF
Usage: $0 [--env development|staging|production] [--state firing|resolved|silenced]
           [--incident-id <id>] [--title <text>]
           [--url <base-url>] [--host <hostname>] [--from-cluster]
           [--namespace <ns>] [--region <region>]
           [--hmac-secret-id <id>] [--dry-run] [--print-host]
           [--canonical-host <value>]

See the header of this file for how the webhook target is resolved and what each
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
    --url)            URL_FLAG="${2:?}"; shift 2 ;;
    --host)           HOST_FLAG="${2:?}"; shift 2 ;;
    --from-cluster)   FROM_CLUSTER=1; shift ;;
    --namespace)      NAMESPACE="${2:?}"; shift 2 ;;
    --region)         REGION="${2:?}"; shift 2 ;;
    --hmac-secret-id) HMAC_SECRET_ID_FLAG="${2:?}"; shift 2 ;;
    --dry-run)        DRY_RUN=1; shift ;;
    --print-host)     PRINT_HOST=1; shift ;;
    # Its value is allowed to be empty: a caller pipes whatever its own
    # configuration holds through this, and "nothing configured" is an answer.
    --canonical-host) (( $# >= 2 )) || usage 1; CANONICALIZE=1; CANONICAL_INPUT="$2"; shift 2 ;;
    -h|--help)        usage 0 ;;
    *)                printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

log() { printf '[drill] %s\n' "$*"; }
die() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }

# The comparison form of anything that names a host: a bare hostname, a hostname
# with a port, or a full base URL. A scheme, a path, a query, a fragment, userinfo,
# a port, letter case and a trailing root dot can all differ between two strings
# that name the same load balancer, so none of them survives into what is
# compared. Userinfo matters as much as the rest: `https://a@b/` is a request to
# `b`, and a check that read `a@b` would be checking a host nothing connects to.
# Curl splits on the last `@`, so this does too.
canonical_host() {
  local v="$1"
  v="${v#*://}"
  v="${v%%/*}"
  v="${v%%\?*}"
  v="${v%%#*}"
  v="${v##*@}"
  case "$v" in
    \[*\]*) v="${v%%\]*}]" ;;  # IPv6 literal — keep the brackets, drop the port
    *)      v="${v%%:*}" ;;
  esac
  v="${v%.}"
  printf '%s' "$v" | tr '[:upper:]' '[:lower:]'
}

# `example.com` is the placeholder this repository ships so the chart renders
# without naming anyone's DNS zone. It resolves to a parked IANA address, so
# firing at it would hang rather than fail. A placeholder is also not an
# identity, so it never counts as an environment's declared host below.
is_placeholder_host() {
  case "$1" in ''|example.com|*.example.com) return 0 ;; *) return 1 ;; esac
}

# A pure string question, answered before anything else so it needs no --env, no
# values files, and none of the payload tooling.
if (( CANONICALIZE == 1 )); then
  CANONICAL_OUTPUT=$(canonical_host "$CANONICAL_INPUT")
  is_placeholder_host "$CANONICAL_OUTPUT" || printf '%s\n' "$CANONICAL_OUTPUT"
  exit 0
fi

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

SCOPED_URL_VAR="DRILL_WEBHOOK_URL_${ENV_UPPER}"
SCOPED_HOST_VAR="DRILL_WEBHOOK_HOST_${ENV_UPPER}"
SCOPED_SECRET_ID_VAR="DRILL_HMAC_SECRET_ID_${ENV_UPPER}"
SCOPED_SECRET_VAR="DRILL_HMAC_SECRET_${ENV_UPPER}"

# `ingress.host` as the named environment declares it, in comparison form. Empty
# when that environment has no values file, which is how a partial fork looks.
declared_host() {
  canonical_host "$(values_get "$REPO_ROOT/chart/values-${1}.yaml" ingress host)"
}

# ── Refuse unscoped overrides ────────────────────────────────────────────────
# A single DRILL_WEBHOOK_HOST applies to every --env, so a caller who exports it
# for staging silently redirects the next production drill — which still signs
# with the production HMAC secret. DRILL_HMAC_SECRET_ID and DRILL_HMAC_SECRET
# are the same variable read from the signing end: either one makes every
# environment sign with whichever environment was exported last. Name the
# problem instead of overruling it.
for unscoped in DRILL_WEBHOOK_URL DRILL_WEBHOOK_HOST DRILL_HMAC_SECRET_ID DRILL_HMAC_SECRET; do
  if [[ -n "${!unscoped:-}" ]]; then
    die "$unscoped is set, and it applies to every --env. Use the environment-scoped name instead: ${unscoped}_${ENV_UPPER} (and ${unscoped}_DEVELOPMENT / ${unscoped}_STAGING / ${unscoped}_PRODUCTION for the others). The drill signs with incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac and delivers to the ${ENVIRONMENT} load balancer, so one variable shared across environments is how one environment's signature reaches another's."
  fi
done

# ── Resolve the one target ───────────────────────────────────────────────────
# TARGET_URL is the single resolved value. TARGET_HOST is derived from it rather
# than carried alongside it, so every check below inspects the URL the POST goes
# to, and `--print-host` cannot describe a different request than the one sent.
NAMED_COUNT=0
NAMED_BY=""
name_target() {
  NAMED_COUNT=$(( NAMED_COUNT + 1 ))
  NAMED_BY="${NAMED_BY:+$NAMED_BY, }$1"
}

if [[ -n "$URL_FLAG" ]];             then name_target "--url"; fi
if [[ -n "$HOST_FLAG" ]];            then name_target "--host"; fi
if [[ -n "${!SCOPED_URL_VAR:-}" ]];  then name_target "$SCOPED_URL_VAR"; fi
if [[ -n "${!SCOPED_HOST_VAR:-}" ]]; then name_target "$SCOPED_HOST_VAR"; fi
if (( FROM_CLUSTER == 1 ));          then name_target "--from-cluster"; fi

if (( NAMED_COUNT > 1 )); then
  die "the webhook target is named $NAMED_COUNT times ($NAMED_BY). Name it once. With two of them, one decides where a ${ENVIRONMENT}-signed alert lands and the other decides nothing — and which is which is not something a caller should have to know. Drop all but one."
fi

# `--host` and DRILL_WEBHOOK_HOST_<ENV> name a hostname, optionally with a port.
# A scheme or a path in one of them means the caller meant a URL; say so rather
# than pasting it into one.
require_bare_host() {
  case "$2" in
    *://*|*/*) die "$1 is '$2', which is a URL and not a hostname. Pass a full base URL with --url or $SCOPED_URL_VAR, or name a bare hostname here." ;;
  esac
}

# `--url` and DRILL_WEBHOOK_URL_<ENV> name a base URL. Without a scheme there is
# no reading of the string that curl and the checks are guaranteed to agree on,
# so refuse it rather than guess.
require_base_url() {
  case "$2" in
    http://*|https://*) ;;
    *) die "$1 is '$2', which has no scheme. Pass a full base URL like https://webhook.example-corp.io, or name a bare hostname with --host or $SCOPED_HOST_VAR." ;;
  esac
}

# OVERRIDDEN marks the paths that name a target from outside the chart. Those
# are the ones checked against the environment's declared host below; the values
# file and the live Ingress are not overrides of anything.
OVERRIDDEN=0

if [[ -n "$URL_FLAG" ]]; then
  SOURCE="--url"; OVERRIDDEN=1
  require_base_url "$SOURCE" "$URL_FLAG"
  TARGET_URL="$URL_FLAG"
elif [[ -n "$HOST_FLAG" ]]; then
  SOURCE="--host"; OVERRIDDEN=1
  require_bare_host "$SOURCE" "$HOST_FLAG"
  TARGET_URL="https://${HOST_FLAG}"
elif [[ -n "${!SCOPED_URL_VAR:-}" ]]; then
  SOURCE="$SCOPED_URL_VAR"; OVERRIDDEN=1
  require_base_url "$SOURCE" "${!SCOPED_URL_VAR}"
  TARGET_URL="${!SCOPED_URL_VAR}"
elif [[ -n "${!SCOPED_HOST_VAR:-}" ]]; then
  SOURCE="$SCOPED_HOST_VAR"; OVERRIDDEN=1
  require_bare_host "$SOURCE" "${!SCOPED_HOST_VAR}"
  TARGET_URL="https://${!SCOPED_HOST_VAR}"
elif (( FROM_CLUSTER == 1 )); then
  SOURCE="live Ingress in $NAMESPACE"
  command -v kubectl >/dev/null || die "--from-cluster needs kubectl on PATH"
  LIVE_HOST=$(kubectl -n "$NAMESPACE" get ingress -l incident-response.io/service=webhook \
    -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
  [[ -n "$LIVE_HOST" ]] || die "no webhook Ingress in namespace $NAMESPACE — is the chart deployed to the cluster your kubeconfig points at?"
  require_bare_host "$SOURCE" "$LIVE_HOST"
  TARGET_URL="https://${LIVE_HOST}"
else
  SOURCE="chart/values-${ENVIRONMENT}.yaml"
  VALUES_HOST=$(values_lookup ingress host)
  [[ -n "$VALUES_HOST" ]] || die "ingress.host is empty in chart/values-${ENVIRONMENT}.yaml — set it, pass --host/--url, set ${SCOPED_HOST_VAR}, or use --from-cluster"
  require_bare_host "$SOURCE" "$VALUES_HOST"
  TARGET_URL="https://${VALUES_HOST}"
fi

TARGET_URL="${TARGET_URL%/}"
TARGET_HOST=$(canonical_host "$TARGET_URL")
[[ -n "$TARGET_HOST" ]] || die "no hostname in the target from $SOURCE — pass a URL with a scheme and a host, like https://webhook.example-corp.io"

# A resolved host has to look like one. Anything else — a brace curl would treat
# as a glob, a space, a character no DNS name carries — means the string the
# rules below compare is not the string curl would connect to, and that gap is
# the one thing none of the rules can tolerate.
case "$TARGET_HOST" in
  \[*\]) ;;  # IPv6 literal
  *[!a-z0-9._-]*)
    die "$SOURCE resolves to '$TARGET_HOST', which is not a hostname. Pass a hostname, optionally with a port, or a base URL whose host is one."
    ;;
esac

if is_placeholder_host "$TARGET_HOST"; then
  die "$SOURCE resolves to the placeholder host '$TARGET_HOST'. Set chart/values-${ENVIRONMENT}.yaml's ingress.host to the hostname external-dns published for the ALB, pass --host <hostname> or --url <base-url>, set ${SCOPED_HOST_VAR}, or use --from-cluster."
fi

# ── Keep the signature and the destination in the same environment ───────────
# The drill signs with this environment's HMAC secret. Both checks below compare
# canonical hostnames, so a port, a path, a capital letter or a trailing dot
# cannot hide a collision, and both run before a payload is built — a
# cross-environment target never reaches the signing step, let alone the network.
DECLARED_HOST=$(declared_host "$ENVIRONMENT")

for other_env in "${ENVIRONMENTS[@]}"; do
  [[ "$other_env" == "$ENVIRONMENT" ]] && continue
  other_host=$(declared_host "$other_env")
  is_placeholder_host "$other_host" && continue
  if [[ "$TARGET_HOST" == "$other_host" ]]; then
    die "refusing to fire: --env $ENVIRONMENT signs with incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac, but $SOURCE resolves to '$TARGET_HOST', which chart/values-${other_env}.yaml declares as the $other_env webhook host. Drill $other_env with --env $other_env."
  fi
done

if (( OVERRIDDEN == 1 )) && ! is_placeholder_host "$DECLARED_HOST" && [[ "$TARGET_HOST" != "$DECLARED_HOST" ]]; then
  die "refusing to fire: chart/values-${ENVIRONMENT}.yaml declares the $ENVIRONMENT webhook host as '$DECLARED_HOST', but $SOURCE resolves to '$TARGET_HOST'. Once the values file names a real host it is what ArgoCD renders the Ingress from and what this environment is; change it there, or use --from-cluster to drill whatever the cluster actually serves."
fi

if (( FROM_CLUSTER == 1 )) && ! is_placeholder_host "$DECLARED_HOST" && [[ "$TARGET_HOST" != "$DECLARED_HOST" ]]; then
  log "WARNING: the live Ingress in $NAMESPACE serves '$TARGET_HOST'; chart/values-${ENVIRONMENT}.yaml declares '$DECLARED_HOST'. Firing at the live one — the chart and the cluster have drifted."
fi

INGRESS_PATH=$(values_lookup ingress path)
[[ -n "$INGRESS_PATH" ]] || die "ingress.path is empty in the chart values — nothing tells the load balancer where to route the webhook"
INGRESS_PATH="${INGRESS_PATH%/}"
TARGET="${TARGET_URL}${INGRESS_PATH}/grafana-oncall"

# ── The signing identity, resolved once ──────────────────────────────────────
# The other half of the pair. A target in the right environment signed with
# another environment's secret is the same misfire read backwards, so the secret
# id is environment-scoped for the same reason the target overrides are, and one
# that names another environment's tree is refused here — before the read, and
# before anything is signed.
HMAC_SECRET_ID="incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac"
HMAC_SECRET_ID_SOURCE="--env $ENVIRONMENT"

if [[ -n "$HMAC_SECRET_ID_FLAG" && -n "${!SCOPED_SECRET_ID_VAR:-}" ]]; then
  die "the HMAC secret id is named twice (--hmac-secret-id, $SCOPED_SECRET_ID_VAR). Name it once — the drill signs with exactly one secret, and which of the two that would be is not something a caller should have to know."
fi

if [[ -n "$HMAC_SECRET_ID_FLAG" ]]; then
  HMAC_SECRET_ID="$HMAC_SECRET_ID_FLAG"; HMAC_SECRET_ID_SOURCE="--hmac-secret-id"
elif [[ -n "${!SCOPED_SECRET_ID_VAR:-}" ]]; then
  HMAC_SECRET_ID="${!SCOPED_SECRET_ID_VAR}"; HMAC_SECRET_ID_SOURCE="$SCOPED_SECRET_ID_VAR"
fi

for other_env in "${ENVIRONMENTS[@]}"; do
  [[ "$other_env" == "$ENVIRONMENT" ]] && continue
  case "/${HMAC_SECRET_ID}/" in
    */"${other_env}"/*)
      die "refusing to fire: --env $ENVIRONMENT delivers to '$TARGET_HOST', but the HMAC secret id from $HMAC_SECRET_ID_SOURCE is '$HMAC_SECRET_ID', which names the $other_env secret tree. Signing with one environment's secret and delivering to another environment's load balancer is the same misfire read backwards. Drill $other_env with --env $other_env."
      ;;
  esac
done

# Resolution and both environment checks are done. Callers that only want to
# know where a drill would land get that hostname on stdout and nothing else.
if (( PRINT_HOST == 1 )); then
  printf '%s\n' "$TARGET_HOST"
  exit 0
fi

log "env=$ENVIRONMENT state=$STATE region=$REGION"
log "webhook_url=$TARGET (resolved from $SOURCE)"
log "incident_id=$INCIDENT_ID"

# ── HMAC secret ──────────────────────────────────────────────────────────────
HMAC_SECRET="${!SCOPED_SECRET_VAR:-}"

if [[ -z "$HMAC_SECRET" ]]; then
  if (( DRY_RUN == 1 )); then
    log "dry run: skipping the Secrets Manager read of $HMAC_SECRET_ID (set $SCOPED_SECRET_VAR to sign anyway)"
  else
    command -v aws >/dev/null || die "aws CLI required to read $HMAC_SECRET_ID — install it, or pass the value in $SCOPED_SECRET_VAR"
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
#
# `-g` turns off curl's URL globbing. Without it `{}` and `[]` in a URL expand
# into several requests, which would mean one checked hostname and several
# addressed ones — the exact split every rule above exists to prevent.
STATUS=$(curl -sS -g -o "$RESP_FILE" -w '%{http_code}' --max-time 10 \
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
  000) die "no response from $TARGET — DNS, TLS, or the load balancer. Check the record external-dns published: dig +short $TARGET_HOST" ;;
  *)   die "unexpected status $STATUS" ;;
esac
