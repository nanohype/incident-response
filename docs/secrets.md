# Secrets seeding

IncidentResponse keeps credentials in **AWS Secrets Manager** — one secret per integration, with separate rotation cadences. This doc covers what each is, how to seed it, how to rotate, and how to verify.

> Two environments, two parallel secret trees. Staging lives under `incident-response/staging/*`, production under `incident-response/production/*`. The commands below show staging; swap `staging` for `production` to seed the other environment.

## The secrets (per environment)

Every secret below is operator-provisioned via `scripts/seed-secrets.sh` **before** the first rollout. The chart's ExternalSecret references them by name; the External Secrets Operator (ESO) projects the matching `incident-response/<env>/*` entries into one k8s Secret consumed via `envFrom`. Nothing in this repo owns the secrets' lifecycle — tearing the tenant down leaves the credentials in place, and no secret values are ever baked into images or manifests.

The ordering invariant (seed → roll out) is universal: the processor pod can't start cleanly until ESO can resolve every `incident-response/<env>/*` reference, so every row below must exist before the rollout. The seeder's `put-or-create` logic handles both the first-deploy case (none exist) and rotation (some or all exist).

The canonical list is `secrets.template.json`. The seeder's `REQUIRED_KEYS` and the chart's `externalsecret.yaml` remoteRefs are cross-checked by a CI grep-gate so they stay in lockstep — editing one without the others fails the build.

| Secret name (staging / production) | What it is |
|---|---|
| `incident-response/{env}/slack/bot-token` | Slack Bot OAuth token (`xoxb-…`). Scopes: `chat:write`, `channels:manage`, `channels:read`, `groups:read`, `groups:write`, `users:read`. |
| `incident-response/{env}/slack/signing-secret` | Slack App signing secret — the webhook Deployment verifies inbound slash-command / interactive-action signatures with it (`src/handlers/slack-signature.ts`, v0 HMAC scheme). |
| `incident-response/{env}/grafana/oncall-token` | Grafana **service-account token** (`glsa_…`) for the OnCall REST API (escalation-chain + on-call rotation reads). **Not** a Cloud Access Policy. See "Grafana credentials — which is which" below. |
| `incident-response/{env}/grafana/cloud-token` | Grafana **Cloud Access Policy** token (`glc_…`) scoped `metrics:read`, `logs:read`, `traces:read` — queries Mimir/Loki/Tempo for the war-room context snapshot. Never write. |
| `incident-response/{env}/grafana/cloud-org-id` | Grafana Cloud org ID (numeric — not a credential; visible in the portal URL). Stored here for operational convenience; could equally be a plain env var. |
| `incident-response/{env}/statuspage/api-key` | Statuspage.io API key. Only the approval gate calls `createIncident` — enforced by CI grep-gate. |
| `incident-response/{env}/statuspage/page-id` | Statuspage.io page ID (visible in the Statuspage URL). |
| `incident-response/{env}/github/token` | GitHub PAT or App token — CODEOWNERS read + recent-commits read for postmortem deploy-timeline. |
| `incident-response/{env}/linear/api-key` | Linear personal API key — postmortem issue creation. |
| `incident-response/{env}/linear/project-id` | Linear Incidents project ID (`UUID`). |
| `incident-response/{env}/linear/team-id` | Linear team ID that owns the Incidents project (required by the `@linear/sdk` issue-create call alongside `project-id`). |
| `incident-response/{env}/workos/api-key` | WorkOS API key (`sk_live_…`) — Directory Sync read (responder resolution by group). |
| `incident-response/{env}/grafana/oncall-webhook-hmac` | Locally-generated shared secret (`openssl rand -base64 32`). Pasted into *both* Grafana OnCall's outgoing-webhook signing field *and* this secret so the webhook handler can verify signatures. Not issued by Grafana. |
| `incident-response/{env}/grafana-cloud/otlp-auth` | JSON payload carrying a Grafana **Cloud Access Policy** write token (`glc_…`, scoped `metrics:write`, `logs:write`, `traces:write`) plus three non-credential identifiers (instance_id, loki_username, loki_host). Consumed by the cluster OTel Collector + log forwarder (eks-gitops). See the schema below. |

> **Different external accounts per environment.** Staging and production typically have their own Slack workspace, Linear project, Statuspage page, WorkOS directory, and Grafana Cloud stack. Don't share credentials across envs — a leaked staging token would otherwise unlock production.

## Grafana Cloud numeric identifiers — which number goes where

Your Grafana Cloud stack publishes at least three **different numeric IDs**. They live on different Connections panels, authenticate different surfaces, and are a common cause of "why is this 401-ing" during seeding. Map them once and keep the scratch notes:

| Field in seed file | What it is | Where to find it | Authenticates |
|---|---|---|---|
| `grafana/cloud-org-id` | **Mimir tenant ID** | grafana.com → your stack → Connections → **Hosted Prometheus Metrics** → "Username / Instance ID" | Queries to `prometheus-prod-XX-prod-<region>.grafana.net` (Mimir metrics read) |
| `grafana-cloud/otlp-auth.instance_id` | **Stack instance ID** (your Grafana stack's top-level numeric identifier) | grafana.com → your stack → **Details** or **Instance** page → "Instance ID" | OTLP basic-auth username against `otlp-gateway-prod-<region>.grafana.net` (cluster collector push) |
| `grafana-cloud/otlp-auth.loki_username` | **Loki tenant ID** | grafana.com → your stack → Connections → **Hosted Logs (Loki)** → "User" | Loki push/query against `logs-prod-XXX.grafana.net` (cluster log forwarder) |

**They are frequently three different numbers.** On some stacks the Mimir tenant ID and stack instance ID coincide; on others they don't. Always read each panel independently — don't assume one ID works everywhere.

Also per-panel + also numeric but not IDs:

- `grafana-cloud/otlp-auth.loki_host` — hostname like `logs-prod-XXX.grafana.net` from the Loki panel. Varies by region within the same stack.
- `GRAFANA_CLOUD_BASE_URL` (chart `env.*`, not a secret) — hostname like `prometheus-prod-XX-prod-<region>.grafana.net` from the Mimir panel. Hardcoded fallback in `src/wiring/dependencies.ts` points at `us-east-0` and probably needs overriding for your region.
- `GRAFANA_ONCALL_BASE_URL` (chart `env.*`, not a secret) — OnCall runs on **its own cluster topology**, independent of your stack. A stack in `prod-us-west-0` can have OnCall at `oncall-prod-us-central-0.grafana.net`. Find your authoritative URL by opening OnCall in the Grafana UI and copying the base from the browser URL.

## Grafana credentials — which is which

IncidentResponse uses **two distinct Grafana auth surfaces** (plus one locally-generated HMAC for webhook-signature verification). They look similar from the outside — both are Bearer-token HTTP auth — but they're created in different parts of the Grafana world and have different permission models. Getting them mixed up is the single most common source of "why is this 401-ing" during first deploy.

| Credential | Created where | Token format | Used by | Scope / role |
|---|---|---|---|---|
| `grafana/oncall-token` | **Recommended:** open OnCall in your Grafana stack → **Settings → API Tokens → + Create Token**. Legacy OnCall-native pattern; simplest path. Fallback: a Grafana service account (`Administration → Users and access → Service accounts`) with OnCall role also works. | OnCall-native token (opaque) OR `glsa_…` from a service account | `src/clients/grafana-oncall-client.ts` calling `https://oncall-prod-<region>.grafana.net/oncall/api/v1/...` | Read-only OnCall access (ack/resolve write scopes if you use those) |
| `grafana/cloud-token` | **grafana.com** → Administration → **Cloud access policies** → new policy → **Add token** | `glc_…` | `src/clients/grafana-cloud-client.ts` calling Mimir/Loki/Tempo query endpoints | Cloud Access Policy with `metrics:read`, `logs:read`, `traces:read` |
| `grafana-cloud/otlp-auth.api_token` | **grafana.com** → Administration → **Cloud access policies** → new policy → **Add token** | `glc_…` | Cluster OTel Collector (metrics + traces) + log forwarder (logs), owned by eks-gitops | Cloud Access Policy with `metrics:write`, `logs:write`, `traces:write` |
| `grafana/oncall-webhook-hmac` | `openssl rand -base64 32` on your laptop | Random base64 | The webhook handler verifying inbound signatures from OnCall | None — shared secret, same value in both this app *and* OnCall's outgoing-webhook config |

**Key points that trip people up:**

- **OnCall uses its own REST API on its own hostname.** Path prefix is `/oncall/api/v1/…` (not `/api/v1/…`) and the auth header is **plain `Authorization: <token>`** (no `Bearer` prefix — OnCall inherited this from its pre-Grafana-acquisition API). Both OnCall-native tokens and Grafana service-account tokens work in this format.
- **OnCall's cluster is independent of your stack's cluster.** A Grafana Cloud stack in `prod-us-west-0` can have its OnCall served from `oncall-prod-us-central-0.grafana.net`. Don't assume the OnCall region matches your stack region — find the authoritative URL by opening OnCall in the Grafana UI and copying the base from the browser URL.
- **Service account ≠ Cloud access policy.** Grafana has two distinct auth systems that both live under "Administration" but target different surfaces. Service accounts auth to *the stack* (dashboards, folders, plugins). Cloud access policies auth to *the data plane* (Mimir/Loki/Tempo query + push). They're not interchangeable.
- **Don't use `sa-1-extsvc-grafana-irm-app`** or any other auto-provisioned `sa-*-extsvc-*` service account. Those are Grafana's internal accounts for plugin-to-stack communication; the UI deliberately hides token creation on them.
- **Read and write access policies are separate** by design. Different blast radii, different rotation cadences, distinct principals in Grafana's audit log. If you absolutely need to simplify, one access policy with both `metrics:read/write`, `logs:read/write`, `traces:read/write` scopes is valid — weaker, but valid.
- **Cloud Access Policy tokens are org-level.** If your org has staging + production Grafana Cloud stacks under the same org, you can issue one set of tokens that work against both — but the `loki_host`, `instance_id`, and `loki_username` identifiers differ per stack, so the `otlp-auth` JSON payload still has to be populated separately for each env.
- **Sanity-check any Grafana token before seeding:**

    ```bash
    # OnCall token (native API token OR service-account glsa_, either works):
    curl -sS -o /dev/null -w 'oncall=%{http_code}\n' \
      -H "Authorization: <token>" \
      https://oncall-prod-<region>.grafana.net/oncall/api/v1/integrations

    # Cloud Access Policy read token, against Mimir:
    curl -sS -o /dev/null -w 'mimir=%{http_code}\n' \
      -u "<cloud-org-id>:glc_..." \
      https://prometheus-prod-<instance>-prod-<region>.grafana.net/api/prom/api/v1/labels
    ```

    Both `200` = good. `401` = wrong kind of token for that endpoint, or a scope mismatch. `530` on OnCall = wrong cluster in the URL.

## The `incident-response/{env}/grafana-cloud/otlp-auth` secret (JSON payload)

One of the secrets carries a structured JSON payload instead of a plain string. The cluster OTel Collector and the log forwarder each need a different subset of the same Grafana Cloud credentials — storing them together in one secret means one rotation instead of several.

The credentials are owned by the cluster OTel Collector + log forwarder (eks-gitops), not by the app pods. The app emits OTLP + structured JSON and never holds the Grafana Cloud write token itself, so no secret is ever baked into an image or manifest. CI enforces the non-bake invariant via a grep-gate (no secrets in committed manifests; ExternalSecret only).

Required schema (same for both envs; different values):

```json
{
  "instance_id":   "<OTLP instance ID from grafana.com → Connections → OpenTelemetry>",
  "api_token":     "<glc_... from a Cloud Access Policy with metrics:write + logs:write + traces:write>",
  "basic_auth":    "<base64(instance_id:api_token)>",
  "loki_username": "<Loki user ID from grafana.com → Connections → Logs (Loki)>",
  "loki_host":     "logs-prod-XXX.grafana.net"
}
```

Field-by-field wiring:

- `instance_id` + `api_token` → cluster OTel Collector (traces + metrics via the `basicauth` extension)
- `basic_auth` (pre-computed, same creds as above, base64'd) → the collector's `Authorization` header for the Grafana Cloud OTLP gateway
- `loki_username` + `api_token` (reused) + `loki_host` → cluster log forwarder → Loki

Creating it for the first time (staging shown; repeat with production values + `incident-response/production/grafana-cloud/otlp-auth`):

```bash
# Gather values from the staging Grafana Cloud stack first.
OTLP_INSTANCE_ID=...
OTLP_API_TOKEN=glc_...
LOKI_USERNAME=...
LOKI_HOST=logs-prod-XXX.grafana.net        # from your stack's Loki panel
BASIC_AUTH=$(printf '%s:%s' "$OTLP_INSTANCE_ID" "$OTLP_API_TOKEN" | base64)

aws secretsmanager create-secret \
  --region us-west-2 \
  --name incident-response/staging/grafana-cloud/otlp-auth \
  --description 'Grafana Cloud (staging): OTLP + Loki + pre-computed basic_auth for the cluster collector.' \
  --secret-string "{
    \"instance_id\":   \"$OTLP_INSTANCE_ID\",
    \"api_token\":     \"$OTLP_API_TOKEN\",
    \"basic_auth\":    \"$BASIC_AUTH\",
    \"loki_username\": \"$LOKI_USERNAME\",
    \"loki_host\":     \"$LOKI_HOST\"
  }"
```

## Seed all secrets in one shot (recommended)

Copy the committed template, fill in the 12 string fields + 4 fields of `grafana-cloud/otlp-auth`, and run the seeder:

```bash
cp secrets.template.json incident-response-secrets.staging.json
# Edit incident-response-secrets.staging.json in your preferred $EDITOR.
#   - Replace every "REPLACE_ME" with the real value.
#   - You can omit `basic_auth` under grafana-cloud/otlp-auth; the script
#     auto-derives it from instance_id + api_token.
#   - The file is gitignored (`incident-response-secrets.*.json` in .gitignore).

npm run seed:staging:dry     # dry-run — validates shape, no AWS calls
npm run seed:staging         # writes to Secrets Manager
```

Safety rails in the seeder (`scripts/seed-secrets.sh`):

- Validates the JSON file has every required key; lists the missing ones and aborts before any AWS call.
- Refuses to run if any value still contains the sentinel `REPLACE_ME` (including nested fields of `grafana-cloud/otlp-auth`).
- Detects whether each secret already exists and picks `put-secret-value` vs. `create-secret` accordingly — so the same command works for first-time seeding (none exist) and rotation (all exist).
- Never logs secret values; only key names, action taken, and character counts in dry-run.
- Auto-computes `basic_auth = base64(instance_id:api_token)` if you don't provide it explicitly.

After seeding, restart the workloads so the pods pick up the freshly-written values (the External Secrets Operator re-syncs the projected Secret on its refresh interval; restarting the pods makes it immediate):

```bash
kubectl rollout restart deploy/incident-response-processor deploy/incident-response-webhook -n tenants-incident-response
```

## Rotate by hand (fallback)

If you need to rotate one key from a machine without the repo checked out, the raw `aws secretsmanager` commands work for secrets that already exist. For first-deploy seeding use the seeder — it creates missing secrets automatically, whereas `put-secret-value` errors on `ResourceNotFoundException`. Pattern below shows staging; swap `staging` for `production`.

```bash
ENV=staging                                           # or: production

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/slack/bot-token \
  --secret-string 'xoxb-...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/slack/signing-secret \
  --secret-string '...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/grafana/oncall-token \
  --secret-string '...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/grafana/cloud-token \
  --secret-string 'glc_...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/grafana/cloud-org-id \
  --secret-string '123456'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/statuspage/api-key \
  --secret-string '...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/statuspage/page-id \
  --secret-string '...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/github/token \
  --secret-string 'ghp_...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/linear/api-key \
  --secret-string 'lin_api_...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/linear/project-id \
  --secret-string '...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/workos/api-key \
  --secret-string 'sk_live_...'

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/grafana/oncall-webhook-hmac \
  --secret-string "$(openssl rand -base64 32)"   # generate a fresh random secret
# — then paste the same value into Grafana OnCall → Webhook integration → Signing secret
```

Then restart that env's workloads so the pods pick up the new values:

```bash
kubectl rollout restart deploy/incident-response-processor deploy/incident-response-webhook -n tenants-incident-response
```

## Rotate a single credential

Secrets Manager overwrites the previous value on `put-secret-value` (with a version history). Rotate the target environment's secret, then restart that env's workloads:

```bash
ENV=staging

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id incident-response/${ENV}/statuspage/api-key \
  --secret-string '<new-value>'

kubectl rollout restart deploy/incident-response-processor deploy/incident-response-webhook -n tenants-incident-response
```

Rotation cadence guidance:

| Family | Cadence | Notes |
|---|---|---|
| Slack bot / signing / app token | 90 days | Or when personnel change. |
| Grafana service account (OnCall) | 90 days | Created in the Grafana stack UI; rotate by adding a new token to the same SA, seeding it, and deleting the old one. |
| Grafana Cloud read access policy (`cloud-token`) | 90 days | Created at grafana.com org level; rotate token on the existing policy. |
| Grafana Cloud write access policy (`otlp-auth.api_token`) | 90 days | Same flow as the read token. When rotating, **regenerate `basic_auth` from the new `instance_id:api_token`** (the seeder does this automatically if you omit `basic_auth`). The cluster OTel Collector + log forwarder (eks-gitops) pick up the new value on their next ExternalSecret sync / restart. |
| OnCall webhook HMAC | 90 days | Generate a fresh `openssl rand -base64 32`, seed it, paste the same value into Grafana OnCall's outgoing-webhook config. |
| Statuspage | 180 days | Or immediately if a publish-gate alarm ever fires. |
| Linear | 180 days | Non-critical (postmortem is best-effort). |
| WorkOS | 90 days | Opens the directory-lookup window; rotate during a maintenance window. |
| GitHub token | 365 days | Read-only scope; low blast radius. |

> Rotate staging and production on independent calendars. Rotating both simultaneously maximises blast radius; staggering by ≥7 days means a bad secret surfaces in staging first.

## Verification

After seeding, confirm every secret for the target env is non-empty and the workloads see them:

```bash
# 1. Did the ExternalSecret sync into a k8s Secret?
kubectl -n tenants-incident-response get externalsecret incident-response \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'

# 2. Did the processor pod start clean?
kubectl -n tenants-incident-response get deploy incident-response-processor \
  -o jsonpath='{.status.readyReplicas}/{.status.replicas}'

# 3. Tail the processor logs for config / collector errors.
kubectl -n tenants-incident-response logs deploy/incident-response-processor --since=5m -f
```

If the processor crash-loops, check the logs (or Grafana Cloud Loki) for `ZodError: required ... missing` — one of the seeded values was skipped or empty. Re-run `npm run seed:{env}:dry` and look for any `REPLACE_ME` sentinels that snuck through.

## Security posture

- Secrets Manager encrypts at rest with an AWS-managed KMS key. To use a customer-managed key, recreate each secret under a CMK via the console or CLI (the seeder honours whatever the secret was created with; nothing in this repo owns the key choice because it doesn't own the secret lifecycle).
- The IAM role is granted `secretsmanager:GetSecretValue` only on the specific ARNs for its own environment — that scope is set in the `landing-zone incident-response-platform` component. No wildcards. The staging role cannot read production secrets and vice versa.
- The chart's ExternalSecret references each secret by name; the External Secrets Operator projects the values into a k8s Secret consumed via `envFrom`. No secret value is ever baked into an image or a committed manifest — a CI grep-gate enforces it (ExternalSecret only).
- The cluster OTel Collector + log forwarder (eks-gitops) hold the Grafana Cloud write token, not the app pods; the app never sees the OTLP `basic_auth`.
- `GetSecretValue` calls (by ESO and the seeder) are audited to CloudTrail with the invoking principal. Rotation should be performed by a dedicated deploy role, not a personal IAM user.
- Never paste a populated secret into chat, issues, or a notebook — Secrets Manager is the authoritative store. The `openssl rand` pattern for the HMAC secret is the one place a value is generated locally; pipe it directly into the seeder and the Grafana OnCall webhook form without writing it to disk.
