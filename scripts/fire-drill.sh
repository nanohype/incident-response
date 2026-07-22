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
#                         [--check-target] [--print-host]
#
# Defaults: --env staging, --state firing, auto-generated incident ID.
#
# ── A drill signs for one environment and has to reach that one ─────────────
#
# The drill signs with incident-response/<env>/grafana/oncall-webhook-hmac. Sign
# for one environment, deliver to another, and a production signature lands on a
# staging load balancer. The invariant, stated once:
#
#   A payload signed for environment X reaches only X's webhook host, or
#   nothing is sent.
#
# Holding that needs an authoritative answer to "which host belongs to which
# environment" — for every environment, not just the one being drilled. A drill
# that cannot name staging's host cannot prove it is missing staging's load
# balancer. So the drill builds one identity map before it resolves anything,
# and an identity it cannot establish is a refusal. There is no path where an
# unknown identity means "carry on".
#
# ── The identity map ────────────────────────────────────────────────────────
#
# Environment X's identity comes from the same three sources, for every X — the
# environment being drilled and the ones being avoided alike:
#
#   DRILL_WEBHOOK_URL_<X>     a base URL, scheme included, no path
#   DRILL_WEBHOOK_HOST_<X>    a hostname, optionally with a port
#   chart/values-<X>.yaml     ingress.host, falling back to chart/values.yaml —
#                             the same two files in the same order that Helm
#                             renders X's Ingress from, so this needs nothing
#                             but a checkout: no kubeconfig, no cluster
#
# Hosts compare canonically. A scheme, a port, a path, userinfo, letter case and
# a trailing root dot can all differ between two strings naming one load
# balancer, so none of them survives into the comparison. `example.com` is the
# placeholder this repository ships so the chart renders without naming anyone's
# DNS zone — a stand-in, never an identity.
#
# Each environment lands in exactly one state:
#
#   known     one canonical host, agreed by every source that named one
#   absent    DRILL_WEBHOOK_HOST_<X> or DRILL_WEBHOOK_URL_<X> is `none` — X has
#             no webhook deployment, so it claims no host and collides with
#             nothing. The one way to say "not deployed" out loud
#   unknown   no source names a host. A fresh checkout is three unknowns
#   conflict  two sources name different hosts
#
# ── What has to hold before anything is signed ──────────────────────────────
#
#   1. Every environment is `known` or `absent`, this one included. An unknown
#      or a conflict anywhere refuses the run and prints the map — a target
#      that cannot be proved to miss staging's load balancer is a target that
#      might be hitting it.
#   2. No two environments claim the same host. One host that is two
#      environments is a host where one environment's signature lands on the
#      other's listener.
#   3. The drilled environment is `known`. There is no drilling an environment
#      declared to have no webhook host.
#   4. The request goes to the drilled environment's host. `--url`, `--host`
#      and the scoped variables are ways to spell that host; one that spells a
#      different host is refused, whether or not the different host belongs to
#      anybody. `--from-cluster` is the deliberate exception: it fires at the
#      Ingress the cluster serves, which still has to miss every other
#      environment's host, and warns when the chart and the cluster disagree.
#   5. Overrides are environment-scoped. An unscoped DRILL_WEBHOOK_URL,
#      DRILL_WEBHOOK_HOST, DRILL_HMAC_SECRET_ID or DRILL_HMAC_SECRET is refused
#      by name rather than ignored — one variable that applies to every `--env`
#      is exactly how the misfire happens, and a caller who set it deserves to
#      be told rather than silently overruled.
#   6. The secret the drill signs with belongs to `--env`. A secret id naming
#      another environment's tree is refused for the same reason a host is.
#
# ── The request is built, never spliced ─────────────────────────────────────
#
# Establishing which host belongs to which environment settles where the request
# should go. It does not settle where the request goes, because a URL assembled
# by pasting strings together can address a host that no check ever saw:
# everything before an `@` is userinfo, so a path of `@other.host/webhook`
# concatenated onto a checked base URL moves the authority to `other.host` while
# every text comparison still reads the checked one. Validating an assembled
# string with shell text operations loses that game — there is always another
# character that means "the authority starts here".
#
# So the URL is not assembled from strings. It is constructed from four
# components, each validated as the kind of thing it is, and no caller-supplied
# string ever lands in the authority position:
#
#   scheme    fixed. Always `https`. Nothing supplies it, so nothing can change
#             it — an `--url` that names `http` is refused rather than honoured
#   host      the hostname the identity map established, or the one a flag named
#             and the map agreed to. A hostname or a bracketed IP literal, and
#             nothing else: no scheme, no path, no port, no userinfo survives
#             into it
#   port      digits, 1-65535, or nothing
#   path      `ingress.path`, held to the shape of a path and then percent-
#             encoded per segment
#
# `ingress.path` gets both halves of that treatment. It is refused outright if it
# does not begin with `/`, or if it carries `@`, `?`, `#`, `%`, a backslash,
# whitespace, a control character, an empty segment, a `.`/`..` segment, or a
# leading `//`. What survives is then percent-encoded against the unreserved set,
# `/` kept as the separator. The two are deliberately redundant: they are
# independent implementations of one constraint, so a gap in either is still
# closed by the other.
#
# ── The parser has the last word before the send ────────────────────────────
#
# Constructing the URL correctly and checking that it was constructed correctly
# are different claims, and only the second one is testable. So the assembled URL
# goes through `new URL()` in node — the same authority resolution curl performs,
# rather than a shell regex approximating it — and the run refuses unless:
#
#   • it parses at all
#   • the scheme is `https`
#   • `username` and `password` are both empty. Userinfo has no legitimate place
#     in a drill URL, so a non-empty one means the authority was rewritten
#   • `hostname` is the host every identity check above was run against
#   • `port` is the port that was validated
#   • `pathname` is exactly the encoded path, and there is no query or fragment
#
# When the parser and the identity map disagree, the run refuses. It does not
# reconcile them: a disagreement means one of the two is wrong about where the
# request is going, and there is no reading of that where sending it is correct.
#
# ── And then the connection that actually happened ──────────────────────────
#
# curl reports `%{url_effective}`, `%{remote_ip}` and `%{remote_port}`, and the
# effective URL goes back through the same parser afterwards. If its host is not
# the host every check was run against, that is a defect in the layers above —
# reported as one, loudly, with a non-zero exit, rather than tolerated.
#
# Be clear about what that buys. It detects a defeated preflight; it does not
# prevent one. By the time curl reports an effective URL the request is already
# on the wire. The construction and the parser check are what stop a misdirected
# request from being sent; this last check is what stops a misdirected request
# from being reported as a successful drill.
#
# `--connect-to` is deliberately not used. Its rules key on the URL's own
# authority, so the form that would pin anything is the match-all form — which
# forces every connection to one address regardless of what the URL says, and so
# hides the exact mismatch this check exists to surface, while introducing
# bracket-parsing ambiguity for the IPv6 literals the host component allows.
# `--proto '=https'` is used, because that one refuses rather than hides.
#
# `--check-target` runs all of it — the map, the resolution, the construction and
# the parser check — prints the map and the request it would send, and exits.
# Zero when a drill would fire where it signs, non-zero with the reason and what
# to configure otherwise. It contacts nothing and needs no credentials, so it is
# the whole verdict a caller needs; .github/workflows/drill.yml asks exactly this
# and holds no second opinion of its own.
#
# `--print-host` prints the host component of the request URL, and nothing else,
# after the same checks. That component is what the URL is built from and what
# the parser confirmed the built URL addresses — so it describes the request the
# drill sends, up to the point where the request leaves. Whether curl agreed is
# the last check above, and it prints a defect when it did not.
#
# The request path comes from `ingress.path`, so the drill follows the listener
# rule instead of assuming one. (`ingress.healthcheckPath` is the ALB
# target-group probe, not a listener rule — it is not reachable from outside the
# load balancer and is no use as a liveness check from here.)
#
# What it does:
#   1. Builds the identity map and resolves one host and port (above)
#   2. Constructs the request URL from validated components and parses it back
#   3. Reads the HMAC secret from Secrets Manager
#      (incident-response/${env}/grafana/oncall-webhook-hmac), or takes the
#      value straight from DRILL_HMAC_SECRET_<ENV>
#   4. Builds a payload that passes GrafanaOnCallPayloadSchema (Zod)
#   5. Signs with HMAC-SHA256 (hex), header `x-grafana-oncall-signature`
#   6. POSTs to https://<host>[:<port>]<encoded ingress.path>/grafana-oncall
#   7. Checks the connection curl reports against the host that was checked
#   8. Echoes the HTTP status + incident ID + next-step hints
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
# Requires: node — the URL parser the construction is checked against, and the
#           runtime this repository already builds on. Plus openssl, jq, curl,
#           and the aws CLI with Secrets Manager read unless
#           DRILL_HMAC_SECRET_<ENV> carries the secret. `--dry-run` resolves the
#           target and builds the payload without contacting anything, so it
#           needs no credentials at all.
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
CHECK_TARGET=0

usage() {
  cat <<EOF
Usage: $0 [--env development|staging|production] [--state firing|resolved|silenced]
           [--incident-id <id>] [--title <text>]
           [--url <base-url>] [--host <hostname>] [--from-cluster]
           [--namespace <ns>] [--region <region>]
           [--hmac-secret-id <id>] [--dry-run] [--check-target] [--print-host]

See the header of this file for how an environment's webhook host is
established, and what each firing produces in your environment.
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
    --check-target)   CHECK_TARGET=1; shift ;;
    --print-host)     PRINT_HOST=1; shift ;;
    -h|--help)        usage 0 ;;
    *)                printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

log() { printf '[drill] %s\n' "$*"; }
# Warnings go to stderr: `--print-host` promises a hostname on stdout and
# nothing else, and a caller piping it should not have to filter prose out.
warn() { printf '[drill] WARNING: %s\n' "$*" >&2; }
die() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }

ENVIRONMENTS=(development staging production)

case "$ENVIRONMENT" in development|staging|production) ;; *) printf '[drill] --env must be development, staging, or production\n' >&2; exit 1 ;; esac
case "$STATE" in firing|resolved|silenced) ;; *) printf '[drill] --state must be firing, resolved, or silenced\n' >&2; exit 1 ;; esac
# node parses the assembled URL, which every mode does — including the two that
# send nothing. A shell substitute would be a second, weaker reading of the
# authority, and a second reading is the thing being removed.
command -v node >/dev/null || { printf '[drill] node required — the assembled request URL is parsed with it before anything is sent\n' >&2; exit 1; }
# `--check-target` and `--print-host` stop before the payload, so they need none
# of the payload tooling. Everything else does.
if (( PRINT_HOST == 0 && CHECK_TARGET == 0 )); then
  command -v openssl >/dev/null || { printf '[drill] openssl required\n' >&2; exit 1; }
  command -v jq      >/dev/null || { printf '[drill] jq required\n' >&2; exit 1; }
  command -v curl    >/dev/null || { printf '[drill] curl required\n' >&2; exit 1; }
fi

[[ -z "$INCIDENT_ID" ]] && INCIDENT_ID="drill-$(date +%s)-$$"
[[ -z "$TITLE" ]] && TITLE="DRILL: synthetic P1 — do not page"

BASE_VALUES="$REPO_ROOT/chart/values.yaml"
ENV_VALUES="$REPO_ROOT/chart/values-${ENVIRONMENT}.yaml"

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

# The two components an authority carries, taken apart rather than kept as one
# string. AUTH_HOST is the comparison form above; AUTH_PORT is whatever followed
# it; AUTH_TRAILER is anything that followed neither, which is the shape of a
# string that names one host to a text comparison and another to a URL parser.
# Nothing here refuses — `require_authority` does — so the placeholder checks can
# read an authority before it has been vetted.
AUTH_HOST=""
AUTH_PORT=""
AUTH_TRAILER=""
split_authority() {
  local raw="$1" v
  AUTH_HOST=$(canonical_host "$raw")
  AUTH_PORT=""
  AUTH_TRAILER=""
  v="${raw#*://}"
  v="${v%%/*}"
  v="${v%%\?*}"
  v="${v%%#*}"
  v="${v##*@}"
  case "$v" in
    \[*\])   ;;
    \[*\]:*) AUTH_PORT="${v##*\]:}" ;;
    \[*)     if [[ "$v" == *\]* ]]; then AUTH_TRAILER="${v#*\]}"; else AUTH_TRAILER="$v"; fi ;;
    *:*)     AUTH_PORT="${v#*:}" ;;
    *)       ;;
  esac
}

# `example.com` is the placeholder this repository ships so the chart renders
# without naming anyone's DNS zone. It resolves to a parked IANA address, so
# firing at it would hang rather than fail. A placeholder is a stand-in, not an
# identity, so it never establishes one.
is_placeholder_host() {
  case "$1" in ''|example.com|*.example.com) return 0 ;; *) return 1 ;; esac
}

# `none` in a scoped variable is the one way to say an environment has no
# webhook deployment. It is a claim, not a silence: an environment nobody claims
# is `unknown`, and unknown refuses.
is_absent_declaration() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in none) return 0 ;; *) return 1 ;; esac
}

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

ENV_UPPER=$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')

SCOPED_SECRET_ID_VAR="DRILL_HMAC_SECRET_ID_${ENV_UPPER}"
SCOPED_SECRET_VAR="DRILL_HMAC_SECRET_${ENV_UPPER}"

# `--host` and DRILL_WEBHOOK_HOST_<ENV> name a hostname, optionally with a port.
# A scheme or a path in one of them means the caller meant a URL; say so rather
# than pasting it into one.
require_bare_host() {
  case "$2" in
    *://*|*/*) die "$1 is '$2', which is a URL and not a hostname. Pass a full base URL with --url or DRILL_WEBHOOK_URL_<ENV>, or name a bare hostname here." ;;
  esac
}

# `--url` and DRILL_WEBHOOK_URL_<ENV> name a base URL: a scheme and an authority,
# and nothing after it. Without a scheme there is no reading of the string that
# curl and the checks are guaranteed to agree on. With a path, a query, a
# fragment or userinfo there is a part of the string the drill would have to
# either drop silently or splice into a request — and both of those are how a
# checked host and a connected host come apart.
require_base_url() {
  local rest
  case "$2" in
    https://*) rest="${2#https://}" ;;
    http://*)  die "$1 is '$2'. The drill speaks https and nothing else — the webhook Ingress terminates TLS at the ALB, and a scheme a caller can change is a scheme that can be downgraded. Name the same host over https." ;;
    *) die "$1 is '$2', which has no scheme. Pass a full base URL like https://webhook.example-corp.io, or name a bare hostname with --host or DRILL_WEBHOOK_HOST_<ENV>." ;;
  esac
  rest="${rest%/}"
  case "$rest" in
    *[/?#@]*) die "$1 is '$2', which carries more than a scheme and a host. A base URL here is https://<host>[:<port>] — the request path comes from the chart's ingress.path, and userinfo, a query and a fragment have no place in it." ;;
  esac
}

# A host has to look like one. Anything else — a brace curl would treat as a
# glob, a space, a character no DNS name carries — means the string compared is
# not the string curl would connect to, and that gap is the one thing no check
# can tolerate.
require_hostname() {
  local inner
  case "$3" in
    \[*\])  # IPv6 literal — hex groups, colons, and the dotted tail of a v4-mapped address
      inner="${3#\[}"; inner="${inner%\]}"
      case "$inner" in
        ''|*[!0-9a-f:.]*)
          die "$1 is '$2', whose host reads as '$3'. That is not a hostname — the brackets say IP literal, and what they hold is not one."
          ;;
      esac
      ;;
    ''|*[!a-z0-9._-]*)
      die "$1 is '$2', whose host reads as '$3'. That is not a hostname — pass a hostname, optionally with a port, or a base URL whose host is one."
      ;;
  esac
}

# A port is a number in range. Anything else means the split above found
# something that is not a port where a port belongs, and a string that is not
# a port cannot be reasoned about as one.
require_port() {
  if [[ -z "$3" ]]; then
    return 0
  fi
  case "$3" in
    *[!0-9]*) die "$1 is '$2', whose port reads as '$3'. A port is digits and nothing else." ;;
  esac
  if (( ${#3} > 5 )) || (( 10#$3 < 1 )) || (( 10#$3 > 65535 )); then
    die "$1 is '$2', whose port reads as '$3'. A port is between 1 and 65535."
  fi
}

# Everything a source says about an authority, held to what an authority is:
# a host, optionally a port, and nothing else. This is the only gate anything
# reaches the host and port components through.
require_authority() {
  split_authority "$2"
  [[ -z "$AUTH_TRAILER" ]] || die "$1 is '$2', and '$AUTH_TRAILER' follows the host where a port or nothing belongs. A string that carries something else after the host names one thing to a text comparison and another to a URL parser."
  require_hostname "$1" "$2" "$AUTH_HOST"
  require_port "$1" "$2" "$AUTH_PORT"
}

# ── The request path ────────────────────────────────────────────────────────
# A webhook path is a path. Every character refused below is a character that
# can end the path component and start something else — an authority, a query,
# a fragment — which is how a path decides where a request goes.
require_path() {
  local what="$1" p="$2"
  [[ -n "$p" ]] || die "$what is empty — nothing tells the load balancer where to route the webhook"
  [[ "$p" == /* ]] || die "$what is '$p', which does not begin with '/'. A listener rule matches a path, and a path starts at the root."
  [[ "$p" != //* ]] || die "$what is '$p'. A leading '//' is a protocol-relative authority: it names a host, not a path."
  case "$p" in
    *@*)  die "$what is '$p', which contains '@'. Everything before an '@' in a URL is userinfo, so a path carrying one moves the host the request reaches." ;;
    *\?*) die "$what is '$p', which contains '?'. That ends the path and starts a query string." ;;
    *"#"*) die "$what is '$p', which contains '#'. That ends the path and starts a fragment." ;;
    *\\*) die "$what is '$p', which contains a backslash. Parsers disagree about whether that is a separator, and a disagreement about where the authority ends is the whole problem." ;;
    *%*)  die "$what is '$p', which contains '%'. A percent-escape here would be decoded by something downstream into a character this refused — write the literal path." ;;
    *//*) die "$what is '$p', which has an empty segment. A path is segments separated by '/'." ;;
    */./*|*/.|*/../*|*/..) die "$what is '$p', which has a '.' or '..' segment. A drill fires at the path the chart routes, not at one derived from it." ;;
    *[[:space:]]*|*[[:cntrl:]]*) die "$what is '$p', which carries whitespace or a control character. Neither survives a URL intact, and what it becomes is not something this can predict." ;;
  esac
}

# Percent-encode against the unreserved set, keeping '/' as the segment
# separator. Deliberately redundant with `require_path`: two independent
# implementations of one constraint, so a character that slips past one is still
# encoded harmless by the other. Byte-wise, so a multi-byte character encodes to
# the bytes a URL carries rather than to a code point.
encode_path() {
  local LC_ALL=C p="$1" out="" i ch
  for (( i = 0; i < ${#p}; i++ )); do
    ch="${p:i:1}"
    case "$ch" in
      [A-Za-z0-9._~/-]) out+="$ch" ;;
      *)                out+=$(printf '%%%02X' "'$ch") ;;
    esac
  done
  printf '%s' "$out"
}

# ── The parser check ────────────────────────────────────────────────────────
# The assembled URL, read the way curl reads it. Shell text operations resolve an
# authority by approximation; `new URL()` resolves it the way the thing that
# connects does. Prints `<hostname> <port> <pathname>` on agreement, and the
# disagreement on stderr otherwise.
verify_url() {
  DRILL_VERIFY_URL="$1" DRILL_VERIFY_HOST="$2" DRILL_VERIFY_PORT="$3" DRILL_VERIFY_PATH="$4" node -e '
    const raw = process.env.DRILL_VERIFY_URL;
    let u;
    try {
      u = new URL(raw);
    } catch {
      console.error("it does not parse as a URL at all");
      process.exit(1);
    }
    const normalize = (host) => {
      try {
        return new URL("https://" + host).hostname;
      } catch {
        return null;
      }
    };
    const want = normalize(process.env.DRILL_VERIFY_HOST);
    const problems = [];
    if (u.protocol !== "https:") {
      problems.push("its scheme is " + u.protocol + ", and the drill only speaks https:");
    }
    if (u.username !== "" || u.password !== "") {
      problems.push("its authority carries userinfo, so the host it reaches is not the host that was checked");
    }
    if (want === null) {
      problems.push("the checked host " + process.env.DRILL_VERIFY_HOST + " is not a host a parser can read");
    } else if (u.hostname !== want) {
      problems.push("it addresses the host " + u.hostname + ", and every check above was run against " + want);
    }
    if (u.port !== process.env.DRILL_VERIFY_PORT) {
      problems.push("it addresses port " + (u.port === "" ? "<none>" : u.port) + ", and the port that was checked is " + (process.env.DRILL_VERIFY_PORT === "" ? "<none>" : process.env.DRILL_VERIFY_PORT));
    }
    if (u.pathname !== process.env.DRILL_VERIFY_PATH) {
      problems.push("its path is " + u.pathname + ", and the path that was built is " + process.env.DRILL_VERIFY_PATH);
    }
    if (u.search !== "" || u.hash !== "") {
      problems.push("it carries a query or a fragment, which nothing here put there");
    }
    if (problems.length > 0) {
      console.error(problems.join("; "));
      process.exit(1);
    }
    process.stdout.write(u.hostname + " " + u.port + " " + u.pathname + "\n");
  '
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

# ── The identity map ─────────────────────────────────────────────────────────
# Built once, for every environment, from the same three sources. Nothing below
# asks a different question of a different environment.
IDENT_STATE=()   # known | absent | unknown | conflict
IDENT_HOST=()    # canonical host, when known
IDENT_PORT=()    # the port that came with it, when it came with one
IDENT_SOURCE=()  # what established it
IDENT_NOTE=()    # why it is unknown, or which two sources conflict

env_index() {
  local e i=0
  for e in "${ENVIRONMENTS[@]}"; do
    [[ "$e" == "$1" ]] && { printf '%s' "$i"; return 0; }
    i=$(( i + 1 ))
  done
  return 1
}

build_identity() {
  local env="$1" upper uvar hvar uval hval vraw vsrc idx
  local -a c_src=() c_kind=() c_host=() c_port=()

  upper=$(printf '%s' "$env" | tr '[:lower:]' '[:upper:]')
  uvar="DRILL_WEBHOOK_URL_${upper}";  uval="${!uvar:-}"
  hvar="DRILL_WEBHOOK_HOST_${upper}"; hval="${!hvar:-}"

  vsrc="chart/values-${env}.yaml"
  vraw=$(values_get "$REPO_ROOT/chart/values-${env}.yaml" ingress host)
  if [[ -z "$vraw" ]]; then
    vraw=$(values_get "$BASE_VALUES" ingress host)
    [[ -n "$vraw" ]] && vsrc="chart/values.yaml"
  fi

  # Each source is taken apart into a host and a port here, once. Nothing
  # downstream ever sees the string a source wrote — only the two components it
  # was found to name.
  if [[ -n "$uval" ]]; then
    if is_absent_declaration "$uval"; then
      c_src+=("$uvar"); c_kind+=(absent); c_host+=(""); c_port+=("")
    else
      require_base_url "$uvar" "$uval"
      require_authority "$uvar" "$uval"
      ! is_placeholder_host "$AUTH_HOST" || die "$uvar is '$uval', whose host is the placeholder this repository ships. Name the hostname external-dns published for the $env ALB, or say the environment has no webhook deployment with $uvar=none."
      c_src+=("$uvar"); c_kind+=(host); c_host+=("$AUTH_HOST"); c_port+=("$AUTH_PORT")
    fi
  fi

  if [[ -n "$hval" ]]; then
    if is_absent_declaration "$hval"; then
      c_src+=("$hvar"); c_kind+=(absent); c_host+=(""); c_port+=("")
    else
      require_bare_host "$hvar" "$hval"
      require_authority "$hvar" "$hval"
      ! is_placeholder_host "$AUTH_HOST" || die "$hvar is '$hval', which is the placeholder this repository ships. Name the hostname external-dns published for the $env ALB, or say the environment has no webhook deployment with $hvar=none."
      c_src+=("$hvar"); c_kind+=(host); c_host+=("$AUTH_HOST"); c_port+=("$AUTH_PORT")
    fi
  fi

  # A values file carrying the shipped placeholder names nothing. That is the
  # state of a fresh checkout, and it is what makes every environment unknown
  # until a fork says otherwise.
  if [[ -n "$vraw" ]] && ! is_placeholder_host "$(canonical_host "$vraw")"; then
    require_bare_host "$vsrc" "$vraw"
    require_authority "$vsrc" "$vraw"
    c_src+=("$vsrc"); c_kind+=(host); c_host+=("$AUTH_HOST"); c_port+=("$AUTH_PORT")
  fi

  local state=unknown host="" port="" source="" note="" i=0
  while (( i < ${#c_src[@]} )); do
    if [[ "${c_kind[$i]}" == "absent" ]]; then
      if [[ "$state" == "known" ]]; then
        state=conflict; note="${source} names '${host}', ${c_src[$i]} says $env has no webhook host"; break
      fi
      state=absent; source="${c_src[$i]}"
    else
      if [[ "$state" == "absent" ]]; then
        state=conflict; note="${source} says $env has no webhook host, ${c_src[$i]} names '${c_host[$i]}'"; break
      fi
      if [[ "$state" == "known" && "$host" != "${c_host[$i]}" ]]; then
        state=conflict; note="${source} names '${host}', ${c_src[$i]} names '${c_host[$i]}'"; break
      fi
      if [[ "$state" != "known" ]]; then
        state=known; host="${c_host[$i]}"; port="${c_port[$i]}"; source="${c_src[$i]}"
      fi
    fi
    i=$(( i + 1 ))
  done

  if [[ "$state" == "unknown" ]]; then
    if [[ -n "$vraw" ]]; then
      note="chart/values-${env}.yaml carries the placeholder '${vraw}', and no DRILL_WEBHOOK_HOST_${upper} / DRILL_WEBHOOK_URL_${upper} names one"
    else
      note="no chart/values-${env}.yaml ingress.host, no DRILL_WEBHOOK_HOST_${upper}, no DRILL_WEBHOOK_URL_${upper}"
    fi
  fi

  idx=$(env_index "$env")
  IDENT_STATE[idx]="$state"
  IDENT_HOST[idx]="$host"
  IDENT_PORT[idx]="$port"
  IDENT_SOURCE[idx]="$source"
  IDENT_NOTE[idx]="$note"
}

for env in "${ENVIRONMENTS[@]}"; do
  build_identity "$env"
done

identity_table() {
  local e idx
  for e in "${ENVIRONMENTS[@]}"; do
    idx=$(env_index "$e")
    case "${IDENT_STATE[$idx]}" in
      known)    printf '  %-12s %-42s from %s\n' "$e" "${IDENT_HOST[$idx]}" "${IDENT_SOURCE[$idx]}" ;;
      absent)   printf '  %-12s %-42s from %s\n' "$e" "no webhook deployment" "${IDENT_SOURCE[$idx]}" ;;
      unknown)  printf '  %-12s %-42s %s\n'      "$e" "UNKNOWN" "${IDENT_NOTE[$idx]}" ;;
      conflict) printf '  %-12s %-42s %s\n'      "$e" "CONFLICTING" "${IDENT_NOTE[$idx]}" ;;
    esac
  done
}

# An environment declared absent is the one claim here nothing can check: a
# hostname can be compared, "there is no host" cannot. Say so out loud on every
# run that leans on one, rather than letting it sit silently in a variable.
warn_absent_declarations() {
  local e idx upper
  for e in "${ENVIRONMENTS[@]}"; do
    idx=$(env_index "$e")
    [[ "${IDENT_STATE[$idx]}" == "absent" ]] || continue
    upper=$(printf '%s' "$e" | tr '[:lower:]' '[:upper:]')
    warn "$e is declared to have no webhook deployment (${IDENT_SOURCE[$idx]}=none), so nothing held this request against a $e host. If $e is in fact deployed, name its host in DRILL_WEBHOOK_HOST_${upper} instead — this is the one place the drill takes the operator's word."
  done
}

# A refusal prints the map. The map is the reason, and it is what a caller has to
# change.
refuse() {
  printf '[drill] FAIL: %s\n' "$1" >&2
  printf '\n[drill] environment identities:\n' >&2
  identity_table >&2
  printf '\n[drill] %s\n' "$2" >&2
  exit 1
}

how_to_name_a_host() {
  local env="$1" upper
  upper=$(printf '%s' "$env" | tr '[:lower:]' '[:upper:]')
  printf "Set chart/values-%s.yaml's ingress.host to the hostname external-dns published for the %s ALB, or set DRILL_WEBHOOK_HOST_%s (or DRILL_WEBHOOK_URL_%s) to it. If %s has no webhook deployment, say so: DRILL_WEBHOOK_HOST_%s=none." \
    "$env" "$env" "$upper" "$upper" "$env" "$upper"
}

# ── Every environment has to be answerable ───────────────────────────────────
# Conflicts first: a contradiction is a stronger statement than a silence, and
# fixing it may be all a caller has to do.
for env in "${ENVIRONMENTS[@]}"; do
  idx=$(env_index "$env")
  if [[ "${IDENT_STATE[$idx]}" == "conflict" ]]; then
    refuse "two sources name the $env webhook host differently — ${IDENT_NOTE[$idx]}. While they disagree there is no fact about where $env lives, and a ${ENVIRONMENT} drill cannot prove it is missing it." \
      "Make them agree, or drop one of them."
  fi
done

# ── One host cannot be two environments ──────────────────────────────────────
# Before the unknowns, because a collision is a fact about hosts that are named
# rather than a gap in what is named.
for env in "${ENVIRONMENTS[@]}"; do
  idx=$(env_index "$env")
  [[ "${IDENT_STATE[$idx]}" == "known" ]] || continue
  for other_env in "${ENVIRONMENTS[@]}"; do
    other_idx=$(env_index "$other_env")
    (( other_idx > idx )) || continue
    [[ "${IDENT_STATE[$other_idx]}" == "known" ]] || continue
    if [[ "${IDENT_HOST[$idx]}" == "${IDENT_HOST[$other_idx]}" ]]; then
      refuse "$env and $other_env both claim the webhook host '${IDENT_HOST[$idx]}'. One host serving two environments is a host where one environment's signature lands on the other's listener, and no drill can tell the two apart." \
        "Give each of them the host its own ALB answers on. If one of the two has no webhook deployment, say that instead: DRILL_WEBHOOK_HOST_$(printf '%s' "$env" | tr '[:lower:]' '[:upper:]')=none, or the same for $other_env."
    fi
  done
done

# ── An environment nobody names is an environment nothing can miss ───────────
# The drilled one first: "I do not know where you are firing" is a plainer thing
# to be told than "I cannot rule out somewhere else".
for env in "$ENVIRONMENT" "${ENVIRONMENTS[@]}"; do
  idx=$(env_index "$env")
  [[ "${IDENT_STATE[$idx]}" == "unknown" ]] || continue
  if [[ "$env" == "$ENVIRONMENT" ]]; then
    refuse "nothing establishes a webhook host for $ENVIRONMENT, so this drill has no idea where it would be firing." \
      "$(how_to_name_a_host "$env")"
  fi
  refuse "nothing establishes a webhook host for $env. This drill signs with incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac, and while $env has no known host there is no proving the request misses $env's load balancer — so it does not go out." \
    "$(how_to_name_a_host "$env")"
done

DRILL_IDX=$(env_index "$ENVIRONMENT")
if [[ "${IDENT_STATE[$DRILL_IDX]}" == "absent" ]]; then
  refuse "--env $ENVIRONMENT is declared to have no webhook deployment by ${IDENT_SOURCE[$DRILL_IDX]}, so there is nothing to drill." \
    "Drop that declaration and name $ENVIRONMENT's host, or drill an environment that has one."
fi

DECLARED_HOST="${IDENT_HOST[$DRILL_IDX]}"

# ── Resolve the one target ───────────────────────────────────────────────────
# What resolution produces is two components — TARGET_HOST and TARGET_PORT — not
# a URL. Every check below reads those components, and the URL is built from them
# further down, so there is no string in between for a check to read differently
# from the thing that connects.
#
# The scoped variables are not resolved a second time here: they are already in
# the identity map, and the map is where the target comes from when no flag
# names one.
NAMED_COUNT=0
NAMED_BY=""
name_target() {
  NAMED_COUNT=$(( NAMED_COUNT + 1 ))
  NAMED_BY="${NAMED_BY:+$NAMED_BY, }$1"
}

if [[ -n "$URL_FLAG" ]];    then name_target "--url"; fi
if [[ -n "$HOST_FLAG" ]];   then name_target "--host"; fi
if (( FROM_CLUSTER == 1 )); then name_target "--from-cluster"; fi

if (( NAMED_COUNT > 1 )); then
  die "the webhook target is named $NAMED_COUNT times ($NAMED_BY). Name it once. With two of them, one decides where a ${ENVIRONMENT}-signed alert lands and the other decides nothing — and which is which is not something a caller should have to know. Drop all but one."
fi

if [[ -n "$URL_FLAG" ]]; then
  SOURCE="--url"
  require_base_url "$SOURCE" "$URL_FLAG"
  require_authority "$SOURCE" "$URL_FLAG"
  TARGET_HOST="$AUTH_HOST"; TARGET_PORT="$AUTH_PORT"
elif [[ -n "$HOST_FLAG" ]]; then
  SOURCE="--host"
  require_bare_host "$SOURCE" "$HOST_FLAG"
  require_authority "$SOURCE" "$HOST_FLAG"
  TARGET_HOST="$AUTH_HOST"; TARGET_PORT="$AUTH_PORT"
elif (( FROM_CLUSTER == 1 )); then
  SOURCE="live Ingress in $NAMESPACE"
  command -v kubectl >/dev/null || die "--from-cluster needs kubectl on PATH"
  LIVE_HOST=$(kubectl -n "$NAMESPACE" get ingress -l incident-response.io/service=webhook \
    -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
  [[ -n "$LIVE_HOST" ]] || die "no webhook Ingress in namespace $NAMESPACE — is the chart deployed to the cluster your kubeconfig points at?"
  require_bare_host "$SOURCE" "$LIVE_HOST"
  require_authority "$SOURCE" "$LIVE_HOST"
  TARGET_HOST="$AUTH_HOST"; TARGET_PORT="$AUTH_PORT"
else
  SOURCE="${IDENT_SOURCE[$DRILL_IDX]}"
  TARGET_HOST="${IDENT_HOST[$DRILL_IDX]}"
  TARGET_PORT="${IDENT_PORT[$DRILL_IDX]}"
fi

# ── The request goes where the signature belongs ─────────────────────────────
if (( FROM_CLUSTER == 1 )); then
  # The live Ingress is what the cluster serves for this environment, which is
  # the one reading of "$ENVIRONMENT's host" the chart cannot overrule. It still
  # has to miss every other environment.
  if is_placeholder_host "$TARGET_HOST"; then
    refuse "the live Ingress in $NAMESPACE serves the placeholder host '$TARGET_HOST'. That is the value this repository ships, not a hostname anything answers on." \
      "Deploy the chart with ingress.host set, then drill again."
  fi
  for other_env in "${ENVIRONMENTS[@]}"; do
    [[ "$other_env" == "$ENVIRONMENT" ]] && continue
    other_idx=$(env_index "$other_env")
    [[ "${IDENT_STATE[$other_idx]}" == "known" ]] || continue
    if [[ "$TARGET_HOST" == "${IDENT_HOST[$other_idx]}" ]]; then
      refuse "the live Ingress in $NAMESPACE serves '$TARGET_HOST', which is $other_env's webhook host — and this drill signs with incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac." \
        "Point your kubeconfig at the $ENVIRONMENT cluster, or drill $other_env with --env $other_env."
    fi
  done
  if [[ "$TARGET_HOST" != "$DECLARED_HOST" ]]; then
    warn "the live Ingress in $NAMESPACE serves '$TARGET_HOST'; $ENVIRONMENT's host is '$DECLARED_HOST' per ${IDENT_SOURCE[$DRILL_IDX]}. Firing at the live one — the chart and the cluster have drifted."
  fi
elif [[ "$TARGET_HOST" != "$DECLARED_HOST" ]]; then
  claimed_by=""
  for other_env in "${ENVIRONMENTS[@]}"; do
    [[ "$other_env" == "$ENVIRONMENT" ]] && continue
    other_idx=$(env_index "$other_env")
    [[ "${IDENT_STATE[$other_idx]}" == "known" ]] || continue
    [[ "$TARGET_HOST" == "${IDENT_HOST[$other_idx]}" ]] && claimed_by="$other_env"
  done
  if [[ -n "$claimed_by" ]]; then
    refuse "$SOURCE resolves to '$TARGET_HOST', which is $claimed_by's webhook host — and this drill signs with incident-response/${ENVIRONMENT}/grafana/oncall-webhook-hmac." \
      "Drill $claimed_by with --env $claimed_by."
  fi
  refuse "$SOURCE resolves to '$TARGET_HOST', and $ENVIRONMENT's webhook host is '$DECLARED_HOST' per ${IDENT_SOURCE[$DRILL_IDX]}. A ${ENVIRONMENT}-signed payload goes to $ENVIRONMENT's host and nowhere else." \
    "Name '$DECLARED_HOST' here, change what ${IDENT_SOURCE[$DRILL_IDX]} says $ENVIRONMENT is, or use --from-cluster to fire at whatever the cluster actually serves."
fi

# ── Construct the request ────────────────────────────────────────────────────
# Four components, each already validated as the kind of thing it is: the fixed
# scheme, the host resolution produced, the port that came with it, and the
# chart's path held to the shape of a path and then encoded. Nothing a caller
# wrote reaches the authority position, because nothing a caller wrote is ever
# put anywhere near it — the authority is built out of TARGET_HOST and
# TARGET_PORT, and those are components, not text a source supplied.
INGRESS_PATH=$(values_lookup ingress path)
require_path "ingress.path in the chart values" "$INGRESS_PATH"
INGRESS_PATH="${INGRESS_PATH%/}"
REQUEST_PATH="$(encode_path "$INGRESS_PATH")/grafana-oncall"

TARGET="https://${TARGET_HOST}${TARGET_PORT:+:${TARGET_PORT}}${REQUEST_PATH}"

# ── And read it back with a real parser ──────────────────────────────────────
# Constructing the URL correctly and having constructed it correctly are
# different claims. This is the second one, resolved by the same rules curl
# resolves an authority by rather than by another pass of shell text handling.
# A disagreement here is refused, not reconciled: it means one of the two is
# wrong about where the request goes, and neither answer makes sending it right.
if ! VERIFY_DETAIL=$(verify_url "$TARGET" "$TARGET_HOST" "$TARGET_PORT" "$REQUEST_PATH" 2>&1 >/dev/null); then
  die "the request URL the drill assembled does not survive being parsed back: $VERIFY_DETAIL. The URL is '$TARGET', built for host '$TARGET_HOST' from $SOURCE with the path from ingress.path. Nothing is sent while the two readings disagree."
fi

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

# The whole verdict, for a caller that wants it without firing: the map that
# allowed this, the request it allowed, and the secret it would be signed with.
if (( CHECK_TARGET == 1 )); then
  warn_absent_declarations
  log "environment identities:"
  identity_table
  log "$ENVIRONMENT drills $TARGET_HOST"
  log "  target $TARGET (resolved from $SOURCE)"
  log "  hmac   $HMAC_SECRET_ID (from $HMAC_SECRET_ID_SOURCE)"
  exit 0
fi

# Resolution and every check are done. Callers that only want to know where a
# drill would land get that hostname on stdout and nothing else.
if (( PRINT_HOST == 1 )); then
  printf '%s\n' "$TARGET_HOST"
  exit 0
fi

warn_absent_declarations
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
log "POST ${REQUEST_PATH} (state=$STATE)"
RESP_FILE=$(mktemp -t incident-response-drill.XXXXXX)
trap 'rm -f "$RESP_FILE"' EXIT
# A transport failure (DNS, TLS, timeout) exits curl non-zero with `000` on
# stdout. Catch it here so the case below can say something useful instead of
# `set -e` killing the script with no explanation.
#
# `-g` turns off curl's URL globbing. Without it `{}` and `[]` in a URL expand
# into several requests, which would mean one checked hostname and several
# addressed ones — the exact split every check above exists to prevent.
#
# `--proto '=https'` fixes the scheme at the transport, where the scheme is
# acted on. The construction already fixes it; this refuses rather than trusts.
#
# The write-out is what the connection actually was, in curl's own terms.
CURL_REPORT=$(curl -sS -g --proto '=https' -o "$RESP_FILE" \
  -w '%{http_code}|%{url_effective}|%{remote_ip}|%{remote_port}' --max-time 10 \
  -H 'Content-Type: application/json' \
  -H "x-grafana-oncall-signature: $SIGNATURE" \
  -d "$PAYLOAD" \
  "$TARGET") || true

STATUS="000"; EFFECTIVE_URL=""; REMOTE_IP=""; REMOTE_PORT=""
if [[ "$CURL_REPORT" == *"|"*"|"*"|"* ]]; then
  IFS='|' read -r STATUS EFFECTIVE_URL REMOTE_IP REMOTE_PORT <<<"$CURL_REPORT"
  [[ -n "$STATUS" ]] || STATUS="000"
fi

# ── The connection that actually happened ────────────────────────────────────
# Everything above decides what to send. This is the only check that reads what
# was sent, and it does not depend on any of the parsing above being right —
# which is the point of having it. It cannot prevent a misdirected request: by
# the time curl can report an effective URL, the request is on the wire. What it
# prevents is a misdirected request being reported as a drill.
if [[ -n "$EFFECTIVE_URL" ]]; then
  # A connection that never opened reports no address and port 0.
  if [[ -z "$REMOTE_IP" || "$REMOTE_PORT" == "0" ]]; then
    PEER="no connection opened"
    REACHED="Curl never opened a connection, so nothing appears to have received it — but the URL was already wrong before the attempt."
  else
    PEER="${REMOTE_IP} port ${REMOTE_PORT}"
    REACHED="The payload has already gone out, so treat ${REMOTE_IP} port ${REMOTE_PORT} as having received a ${ENVIRONMENT}-signed alert."
  fi
  log "curl reports ${EFFECTIVE_URL} — ${PEER}"
  if ! EFFECTIVE_DETAIL=$(verify_url "$EFFECTIVE_URL" "$TARGET_HOST" "$TARGET_PORT" "$REQUEST_PATH" 2>&1 >/dev/null); then
    die "DEFECT — the request curl made is not the request that was checked: $EFFECTIVE_DETAIL. curl reports '$EFFECTIVE_URL' (${PEER}); the drill assembled '$TARGET' and signed it with $HMAC_SECRET_ID. ${REACHED} This is a bug in this script, not a misconfiguration: the construction and the parser check above are supposed to make it unreachable. Report it with this line."
  fi
fi

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
  404) die "the load balancer did not route ${REQUEST_PATH} — only ingress.path and ingress.slackPath get listener rules, so check the path matches the chart values" ;;
  5??) die "webhook error — check: kubectl -n $NAMESPACE logs deploy/incident-response-webhook --since=10m" ;;
  000) die "no response from $TARGET — DNS, TLS, or the load balancer. Check the record external-dns published: dig +short $TARGET_HOST" ;;
  *)   die "unexpected status $STATUS" ;;
esac
