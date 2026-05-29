#!/usr/bin/env bash
#
# One-shot seeder for a Marshal environment's Secrets Manager payload.
#
# Reads a single JSON file (see secrets.template.json for the shape), then for
# each top-level key writes the value to Secrets Manager at
# `marshal/${env}/${key}`. Robust against both states a secret can be in:
#   - CDK-provisioned, empty  → put-secret-value
#   - not yet created         → create-secret, then put-secret-value
#
# Safety rails:
#   - Any value containing the sentinel `REPLACE_ME` aborts the run before
#     a single API call goes out — guards against a half-filled template.
#   - `--dry-run` lists what would be written without calling AWS.
#   - Never logs secret values. Only key names + AWS action.
#   - For the `grafana-cloud/otlp-auth` nested object, auto-derives
#     `basic_auth = base64(instance_id:api_token)` unless the operator
#     supplied it explicitly (matches the stack's JSON schema).
#
# Usage:
#   scripts/seed-secrets.sh --env staging     --file marshal-secrets.staging.json
#   scripts/seed-secrets.sh --env production  --file marshal-secrets.production.json
#   scripts/seed-secrets.sh --env staging     --file ... --dry-run
#
# Defaults: --region us-west-2, --file marshal-secrets.${env}.json
#
# Requires: aws CLI (with creds that can put/create secrets), jq, base64, openssl.
set -euo pipefail

ENVIRONMENT=""
FILE=""
REGION="us-west-2"
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $0 --env {staging|production} [--file PATH] [--region REGION] [--dry-run]

Seeds all 13 Marshal secrets for the named environment from a JSON file.
See secrets.template.json for the file shape.
EOF
  exit "${1:-1}"
}

while (( $# > 0 )); do
  case "$1" in
    --env)     ENVIRONMENT="${2:?missing value for --env}"; shift 2 ;;
    --file)    FILE="${2:?missing value for --file}"; shift 2 ;;
    --region)  REGION="${2:?missing value for --region}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *)         printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

[[ "$ENVIRONMENT" == "staging" || "$ENVIRONMENT" == "production" ]] \
  || { printf '[seed] --env must be "staging" or "production" (got "%s")\n' "$ENVIRONMENT" >&2; exit 1; }
[[ -z "$FILE" ]] && FILE="marshal-secrets.${ENVIRONMENT}.json"
[[ -f "$FILE" ]] || { printf '[seed] file not found: %s\n' "$FILE" >&2; exit 1; }
command -v jq     >/dev/null || { printf '[seed] jq required\n'     >&2; exit 1; }
command -v base64 >/dev/null || { printf '[seed] base64 required\n' >&2; exit 1; }

log()  { printf '[seed] %s\n' "$*"; }
die()  { printf '[seed] FAIL: %s\n' "$*" >&2; exit 1; }
ok()   { printf '[seed] OK  : %s\n' "$*"; }

# The canonical list of secret paths Marshal expects. Must stay in lockstep
# with `scripts/smoke.sh`'s REQUIRED_SECRETS, `secrets.template.json` keys, and
# the per-secret `name.secret(...)` calls in `infra/lib/marshal-stack.ts`. The
# "inventory drift" grep-gate in `.github/workflows/marshal-ci.yml` enforces
# this mechanically on every push.
REQUIRED_KEYS=(
  "slack/bot-token"
  "slack/signing-secret"
  "slack/app-token"
  "grafana/oncall-token"
  "grafana/cloud-token"
  "grafana/cloud-org-id"
  "statuspage/api-key"
  "statuspage/page-id"
  "github/token"
  "linear/api-key"
  "linear/project-id"
  "linear/team-id"
  "workos/api-key"
  "grafana/oncall-webhook-hmac"
  "grafana-cloud/otlp-auth"
)

log "env=$ENVIRONMENT region=$REGION file=$FILE dry_run=$DRY_RUN"

# ── 1. Validate shape ───────────────────────────────────────────────────────
jq empty "$FILE" 2>/dev/null || die "$FILE is not valid JSON"

missing=()
for k in "${REQUIRED_KEYS[@]}"; do
  if [[ "$(jq --arg k "$k" 'has($k)' "$FILE")" != "true" ]]; then
    missing+=("$k")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf '[seed] FAIL: %s is missing required keys:\n' "$FILE" >&2
  printf '         - %s\n' "${missing[@]}" >&2
  exit 1
fi

# Reject any REPLACE_ME sentinel anywhere in the file (string OR nested).
# `jq -r .. | grep` scans every leaf so it catches nested basic_auth fields too.
if jq -r '.. | select(type == "string")' "$FILE" | grep -q 'REPLACE_ME'; then
  die "$FILE still contains 'REPLACE_ME' placeholder(s) — fill them in before seeding"
fi

# ── 2. Compute basic_auth if the operator left it off ───────────────────────
# The `grafana-cloud/otlp-auth` secret needs a pre-computed `basic_auth` for
# the Lambda webhook's init code. If present, use as-is. If missing but both
# `instance_id` and `api_token` are provided, derive it here so operators
# don't have to remember the `printf '%s:%s' a b | base64` incantation.
PAYLOAD_FILE="$(mktemp -t marshal-seed.XXXXXX)"
trap 'rm -f "$PAYLOAD_FILE"' EXIT

otlp="$(jq -c '."grafana-cloud/otlp-auth"' "$FILE")"
have_basic="$(jq 'has("basic_auth")' <<<"$otlp")"
if [[ "$have_basic" == "false" ]]; then
  instance_id="$(jq -r '.instance_id // empty' <<<"$otlp")"
  api_token="$(jq -r '.api_token // empty'   <<<"$otlp")"
  if [[ -z "$instance_id" || -z "$api_token" ]]; then
    die "grafana-cloud/otlp-auth needs either \`basic_auth\` OR both \`instance_id\` + \`api_token\`"
  fi
  # `printf | base64` — no tr/newline trimming needed (base64 here is single-line on macOS + GNU).
  basic_auth="$(printf '%s:%s' "$instance_id" "$api_token" | base64 | tr -d '\n')"
  otlp="$(jq --arg b "$basic_auth" '. + {basic_auth: $b}' <<<"$otlp")"
  log "grafana-cloud/otlp-auth: basic_auth auto-computed from instance_id + api_token"
fi

# ── 3. Seed loop ────────────────────────────────────────────────────────────
put_or_create() {
  local id="$1" value_file="$2"
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$id" \
       --query 'ARN' --output text >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --region "$REGION" \
      --secret-id "$id" \
      --secret-string "file://$value_file" \
      --query 'VersionId' --output text >/dev/null
    ok "put:    $id"
  else
    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$id" \
      --secret-string "file://$value_file" \
      --description "Marshal ${ENVIRONMENT} — seeded by scripts/seed-secrets.sh" \
      --query 'ARN' --output text >/dev/null
    ok "create: $id"
  fi
}

# Plain-string secrets (12 of them).
for k in "${REQUIRED_KEYS[@]}"; do
  [[ "$k" == "grafana-cloud/otlp-auth" ]] && continue
  id="marshal/${ENVIRONMENT}/${k}"
  value="$(jq -r --arg k "$k" '.[$k]' "$FILE")"
  [[ -n "$value" && "$value" != "null" ]] || die "$k has empty value in $FILE"
  if (( DRY_RUN == 1 )); then
    log "DRY : $id (${#value} chars)"
    continue
  fi
  printf '%s' "$value" > "$PAYLOAD_FILE"
  put_or_create "$id" "$PAYLOAD_FILE"
done

# grafana-cloud/otlp-auth — JSON payload (with auto-computed basic_auth).
id="marshal/${ENVIRONMENT}/grafana-cloud/otlp-auth"
if (( DRY_RUN == 1 )); then
  fields="$(jq -r 'keys | join(", ")' <<<"$otlp")"
  log "DRY : $id (JSON fields: $fields)"
else
  printf '%s' "$otlp" > "$PAYLOAD_FILE"
  put_or_create "$id" "$PAYLOAD_FILE"
fi

log "seeded ${#REQUIRED_KEYS[@]} secrets for ${ENVIRONMENT}"
if (( DRY_RUN == 0 )); then
  log "next: npm run smoke:${ENVIRONMENT}    — verifies all 14 are present + healthy"
fi
