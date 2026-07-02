# Deployment guide

End-to-end walkthrough for bringing incident-response up as a Platform tenant. The app ships as a tenant of the `protohype` team on the `eks-agent-platform` operator: a Helm chart in `chart/`, a `Platform` CR in `platform.yaml`, and an ApplicationSet entry registered in `nanohype/eks-gitops`. Two environments — staging and production — coexist on the same cluster fleet, each with its own namespace-scoped values and `incident-response/<env>/*` secret tree. Stand staging up first, run the drills, then repeat for production.

If you're rotating credentials on an already-running tenant, jump to [`docs/secrets.md`](secrets.md) instead.

## 0. Prerequisites

### AWS side

The AWS substrate — DynamoDB tables, SQS + DLQ, the EventBridge Scheduler group, the S3 audit/artifacts bucket, and the `incident_response_irsa` role — lives in the `incident-response-platform` component in [`landing-zone`](https://github.com/nanohype/landing-zone). Apply it per env with OpenTofu/Terragrunt before deploying the tenant; its `tofu output` values feed the chart (see step 3). You do not provision AWS resources from this repo.

- **Bedrock model access** must be enabled in the cluster's region for:
  - `anthropic.claude-sonnet-4-6` — status drafts + postmortems
  - `anthropic.claude-haiku-4-5-20251001-v1:0` — message classification

  Enable via AWS console → Bedrock → Model access → Request access. Invocation fails at runtime with `AccessDeniedException` otherwise.

  **On-demand throughput caveat.** Claude 4.x-family models require **cross-region inference profiles** for on-demand invocation. Direct foundation-model invocation only works with provisioned-throughput commitments. If you invoke `anthropic.claude-sonnet-4-6` directly you'll get `"Invocation of model ID ... with on-demand throughput isn't supported"` at resolve time. The app uses on-demand throughput by default — see `src/ai/incident-response-ai.ts` and [`docs/troubleshooting.md`](troubleshooting.md) § "Bedrock errors" for the profile-ID switch (`us.anthropic.claude-sonnet-4-6` etc.) if you hit this.
- **Bedrock invocation logging = NONE** is an account-level control owned by `landing-zone`, so IC↔AI conversations never reach CloudWatch. Nothing to do here; just confirm the account-level setting is in place before handling real incidents.

### Third-party accounts (staging + production)

Provision these **separately** for each environment — staging and production each want their own Slack workspace / Linear project / Statuspage page / Grafana Cloud stack. Credentials land in env-scoped Secrets Manager paths (`incident-response/staging/*` vs `incident-response/production/*`); sharing them defeats the isolation.

| System | What you need | Where to get it |
|---|---|---|
| **Slack app** | Bot token (`xoxb-…`), signing secret, app-level token (`xapp-…`) with `connections:write` (socket mode) | [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From manifest. Required scopes: `chat:write`, `channels:manage`, `channels:read`, `groups:read`, `groups:write`, `users:read`, `commands`. |
| **Grafana OnCall** | API token (read-only) + webhook HMAC secret | Grafana → OnCall → Settings → API tokens. HMAC secret is generated locally (`openssl rand -base64 32`) and pasted into the OnCall *outgoing webhook* signing field. |
| **Grafana Cloud** | OTLP instance ID, API token (`glc_…` with `otlp:write`), org ID, Loki username, Loki host | Grafana Cloud → Connections → OpenTelemetry (for OTLP) + Connections → Logs (Loki). See [`docs/secrets.md`](secrets.md) § "The `incident-response/{env}/grafana-cloud/otlp-auth` secret" for the JSON shape. |
| **Statuspage.io** | API key + page ID | Statuspage → Manage → API. Page ID is visible in the Statuspage URL (`manage.statuspage.io/pages/<PAGE_ID>/`). |
| **Linear** | Personal API key + team UUID + project UUID | Linear → Settings → API → Personal API keys. **`linear/team-id` must be the team UUID, not the team key**. Get both UUIDs via GraphQL: `{ teams { nodes { id key name } } projects { nodes { id name } } }` against `https://api.linear.app/graphql`. A team key (`ENG`) in `team-id` produces `Argument Validation Error - teamId must be a UUID` at resolve time. |
| **WorkOS** | Directory Sync API key (`sk_live_…`) + directory ID (`directory_…`) | [dashboard.workos.com](https://dashboard.workos.com) → API Keys; the directory ID is on the Directory Sync page. Also prepare the team-to-group map — see step 4. |
| **GitHub** | PAT or App token | GitHub → Settings → Developer settings → Personal access tokens. Scope: `repo:read` over the repos listed in `GITHUB_REPO_NAMES`. Read-only; used to fetch CODEOWNERS + recent commits for postmortems. |

### Slack app (required before first deploy)

Full walkthrough in [`docs/slack-app-setup.md`](slack-app-setup.md). Summary: you need a Slack app per environment with Socket Mode enabled, Interactivity toggled on, the `/incident-response` slash command registered, the bot token scopes listed in that doc, and all three tokens (bot / app-level / signing-secret) seeded. Without this, the processor crash-loops at Bolt startup.

### Local tooling

- Node 24 (Active LTS)
- `aws` CLI ≥ 2.15 with creds for the target account (for secret seeding + drills)
- `kubectl` + `helm` with a context on the target cluster
- `jq` (recommended for inspecting `tofu output` + Slack/SQS responses)

## Deploy staging first

The rest of this walkthrough deploys the staging tenant. Once staging is live + Drill 2 has passed, re-run the same steps with `production`.

### 1. Seed every secret before the first rollout

Every secret is operator-provisioned — the chart's ExternalSecret references them by name but does not create them. The processor pod won't start cleanly until the External Secrets Operator can resolve every `incident-response/<env>/*` entry, so seed first.

The seeder (`npm run seed:{env}`) handles both first-seed (create) and rotation (put) transparently:

```bash
cp secrets.template.json incident-response-secrets.staging.json
# Edit the file — replace every REPLACE_ME with the real value.
# `incident-response-secrets.*.json` is gitignored.

npm run seed:staging:dry     # validates shape, no AWS calls
npm run seed:staging         # creates every required secret in Secrets Manager
```

The `grafana-cloud/otlp-auth` secret is a nested JSON object carrying the Grafana Cloud telemetry credentials. You can omit `basic_auth` from the JSON — the seeder derives it from `instance_id` + `api_token` automatically. Per-key provenance + rotation guidance in [`docs/secrets.md`](secrets.md).

### 2. Apply the landing-zone substrate + the Platform CR

Apply the `incident-response-platform` component in `landing-zone` for this env (OpenTofu/Terragrunt), then apply the tenant boundary:

```bash
kubectl apply -f platform.yaml      # Platform CR + BudgetPolicy
kubectl -n tenants-protohype get platform incident-response -w   # wait for Ready
```

The operator reconciles Namespace `tenants-protohype`, the ResourceQuota, default-deny NetworkPolicy, the ArgoCD AppProject, and the IAM role. Wait for the Platform to reach `Ready` before registering the ApplicationSet entry.

### 3. Wire chart values from landing-zone outputs

Fill the per-env values from `tofu output` against the `incident-response-platform` component — do **not** hardcode account IDs / ARNs into committed defaults:

```bash
# In landing-zone/live/<env>/aws/incident-response-platform
tofu output   # → irsa_role_arn, incidents_table_name, audit_table_name,
              #   identity_cache_table_name, incident_events_queue_url,
              #   nudge_events_queue_url, nudge_events_queue_arn,
              #   sla_check_queue_url, scheduler_role_arn, scheduler_group_name,
              #   audit_bucket_name
```

Map the table names, queue URLs/ARNs, scheduler ids, and secret ids into the matching `tenantInfra.*` keys (the IAM role is bound by the Pod Identity association, not a chart value). The committed `values.yaml` keeps the placeholders empty (the platform-tenant-contract forbids hardcoded account/region/ARN); fill staging/prod at deploy time.

### 4. WorkOS team → group map

The war-room assembler resolves responders via `WORKOS_TEAM_GROUP_MAP` — a JSON map from Grafana OnCall `team_id` → WorkOS `directory_group_id`. Group lookups are scoped to one directory via `WORKOS_DIRECTORY_ID` (required — the processor fails fast at startup without it). Both are plain env vars (not secrets — just identifier lookups). Set them under the chart's `env.*` block in `chart/values-staging.yaml`:

```yaml
env:
  WORKOS_DIRECTORY_ID: directory_01...
  WORKOS_TEAM_GROUP_MAP: |
    {"team-platform":"directory_group_01...","team-data":"directory_group_01..."}
```

### 5. Render + lint before the rollout

```bash
npm run chart:lint                   # helm lint chart
npm run chart:template:staging       # render with staging values
```

Confirm the rendered Secret has no empty `tenantInfra.*` env, and the dashboard ConfigMap is populated:

```bash
helm template incident-response chart -f chart/values-staging.yaml | grep -c grafana_dashboard
```

### 6. Register the ApplicationSet entry

`gitops/applicationset-entry.yaml` is added to `nanohype/eks-gitops` (`applicationsets/apps-tenants.yaml`). Once registered, ArgoCD renders the chart per cluster/env and rolls out the webhook Deployment, the public Ingress (ingress-nginx + cert-manager TLS for the Grafana OnCall HMAC POSTs), and the processor Deployment. New image tags flow through the release workflow → GHCR → ArgoCD picks up the bump in `chart/values-{env}.yaml`.

### 7. Confirm the rollout is healthy

```bash
kubectl -n tenants-protohype rollout status deploy/incident-response-webhook
kubectl -n tenants-protohype rollout status deploy/incident-response-processor

# ExternalSecret synced into a k8s Secret?
kubectl -n tenants-protohype get externalsecret incident-response -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'

# Webhook HMAC gate is live (unsigned request → 401):
kubectl -n tenants-protohype port-forward svc/incident-response-webhook 3001:80 &
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3001/webhook/grafana-oncall   # expect 401
```

If the processor crash-loops, tail its logs and look for `ZodError: required ... missing` (a seeded secret is empty) or `AccessDeniedException` (Bedrock model access not enabled).

### 8. Wire the staging Grafana OnCall webhook

In **staging** Grafana OnCall → Outgoing webhook:

- **URL:** `https://<ingress-host>/webhook/grafana-oncall` (the cert-manager-issued ingress hostname for staging)
- **HTTP method:** `POST`
- **Signing secret:** the same value you seeded into `incident-response/staging/grafana/oncall-webhook-hmac`
- **Trigger:** `Alert group firing`

The webhook handler verifies HMAC-SHA256 in timing-safe fashion and rejects unsigned requests with `401`.

### 9. Dashboards + alerts

Both ship as Kubernetes resources from the chart — no manual import step. The PrometheusRule is reconciled into Mimir by the kube-prometheus-stack operator from `eks-gitops`; the Grafana dashboard ConfigMap is auto-imported by the Grafana sidecar via the `grafana_dashboard: "1"` label. Nothing to upload.

### 10. Drill

Two complementary paths:

**Scripted drill (fastest — exercises the full path without a real OnCall integration):**

```bash
npm run drill:staging                                 # fires an HMAC-signed synthetic P1
npm run drill:join:staging -- --user U0123ABCD        # invite yourself to the war room
# in the war-room channel:
#   /incident-response status draft    (Bedrock draft)
#   (click Approve & Publish — exercises the two-phase approval gate)
#   /incident-response resolve         (Bedrock postmortem → Linear issue → channel archive)
npm run observe:staging                               # inspect the resulting audit trail
```

Full strategy menu + gotchas in [`docs/drills.md`](drills.md).

**Tabletop + live-fire (formal pre-prod checklist):**

Walk through [`artifacts/incident-drill-playbook.md`](../artifacts/incident-drill-playbook.md):

- **Drill 1 (tabletop)** — walk through a simulated P1 without firing the app.
- **Drill 2 (live-fire)** — send a synthetic alert through staging Grafana OnCall (real webhook, real signing, real routing); confirm assembly ≤5 min, approval gate rejects attempted unsigned publishes, Linear postmortem draft + channel archive appear after `/incident-response resolve`.

**Do not hand a real alert integration to the staging tenant until the scripted drill + Drill 2 pass.**

## Promote to production

Repeat steps 1–9 with `production` in place of `staging`:

```bash
# Seed the production secret tree first (step 1).
npm run seed:production

# Fill chart/values-production.yaml from the production incident-response-platform tofu output (step 3),
# apply platform.yaml, register the production ApplicationSet env, let ArgoCD roll it out.
npm run chart:template:production     # render + sanity-check before commit
```

Production uses completely separate resources:

| | Staging | Production |
|---|---|---|
| Namespace | `tenants-protohype` (staging cluster) | `tenants-protohype` (production cluster) |
| Tables | `incident-response-staging-incidents`, `incident-response-staging-audit` | `incident-response-production-incidents`, `incident-response-production-audit` |
| Queues | `incident-response-staging-incident-events.fifo`, … | `incident-response-production-incident-events.fifo`, … |
| Scheduler group | `incident-response-staging` | `incident-response-production` |
| Secret path | `incident-response/staging/*` | `incident-response/production/*` |
| IAM role | scoped to staging ARNs only | scoped to production ARNs only |

The staging IAM role **cannot** read production secrets (and vice versa) — each environment's role lists only its own secret ARNs.

## Teardown

Removing the tenant is the inverse of the deploy: remove the ApplicationSet entry (ArgoCD prunes the workloads), then `kubectl delete -f platform.yaml`. The DynamoDB tables, the S3 bucket, and the Secrets Manager entries are owned by `landing-zone` (`incident-response-platform`), not by this repo — they survive a tenant teardown so a rebuild can reuse them. To fully remove an environment's data, destroy the `incident-response-platform` component in `landing-zone` and delete the secret tree:

```bash
ENV=staging                                   # or: production
for s in slack/bot-token slack/signing-secret slack/app-token grafana/oncall-token \
         grafana/cloud-token grafana/cloud-org-id statuspage/api-key statuspage/page-id \
         github/token linear/api-key linear/project-id linear/team-id workos/api-key \
         grafana/oncall-webhook-hmac grafana-cloud/otlp-auth; do
  aws secretsmanager delete-secret --region us-west-2 \
    --secret-id "incident-response/${ENV}/$s" --force-delete-without-recovery
done
```

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| ExternalSecret stuck `SecretSyncedError` | A `incident-response/<env>/*` secret doesn't exist yet, or the IAM role lacks `GetSecretValue` on its ARN | Run step 1 for that env; confirm the `incident_response_irsa` role's secrets-read scope in `landing-zone` |
| Processor pod `CrashLoopBackOff` | Zod config fail on startup — one of the per-integration secrets is empty for this env | `kubectl logs deploy/incident-response-processor -n tenants-protohype` and look for the missing key; reseed + `kubectl rollout restart` |
| `npm run typecheck` fails with SDK version errors | Stale `package-lock.json` with drifted peer deps | `rm -rf node_modules package-lock.json && npm install` — details in [`docs/troubleshooting.md`](troubleshooting.md) § "Build / TypeScript errors" |
| Webhook returns 5xx on unsigned POST | Webhook pod crashed before the HMAC check | `kubectl logs deploy/incident-response-webhook -n tenants-protohype`. Usually a missing `GRAFANA_ONCALL_HMAC_SECRET_ID` or a Secrets Manager permission regression |
| DLQ depth > 0 | An incident event failed 3 times | Inspect + drain via `aws sqs receive-message`; the PrometheusRule fires on the `incident-response-{env}-incident-events` DLQ at ≥1 |
| Processor restarts on a loop | Bedrock model access not enabled in the region, or a Grafana Cloud credential in `otlp-auth` is stale | Enable model access; rotate the env-scoped `otlp-auth` — pods pick up the new value on the next `kubectl rollout restart` |
| Resolve fires but "Bedrock postmortem failed" in logs | `claude-sonnet-4-6` requires an inference profile for on-demand throughput | Switch `src/ai/incident-response-ai.ts` model IDs to `us.anthropic.claude-*` profiles. See [`docs/troubleshooting.md`](troubleshooting.md) § "Bedrock errors" |
| Resolve fires but Linear issue doesn't appear | `teamId must be a UUID` — `linear/team-id` secret holds a team key | Reseed with the UUID from `{ teams { nodes { id key } } }`; `kubectl rollout restart deploy/incident-response-processor` |
| Nudge schedule never fires (no `STATUS_REMINDER_SENT` after 15 min) | `Schedule group incident-response-{env} does not exist` in processor logs | The group is owned by `landing-zone incident-response-platform`; confirm it's applied. Details in [`docs/troubleshooting.md`](troubleshooting.md) § "EventBridge Scheduler errors" |
| `AutoPublishNotPermitted` on Approve & Publish | Either a real invariant violation, or a DDB `Limit + FilterExpression` bug in `verifyApprovalBeforePublish` | Query the audit table directly for the incident — if `STATUSPAGE_DRAFT_APPROVED` exists, it's the Limit+Filter bug. Details in [`docs/troubleshooting.md`](troubleshooting.md) § "Runtime errors" |
| Grafana Cloud traces/metrics missing | OTLP export failing | Check the cluster `otel-collector` logs (eks-gitops). If `401`, the `instance_id`/`api_token` in the env's OTLP secret don't match the Grafana Cloud stack. |
| Grafana Cloud Loki logs missing | Cluster log forwarder error | Check the forwarder (eks-gitops). Usually a wrong `loki_host` for the region. |
| Secret rotated but pods still use old value | Pods read the projected Secret at start | `kubectl rollout restart deploy/incident-response-processor -n tenants-protohype` (and `deploy/incident-response-webhook`) to pick up the new value |
| Staging event fired in production's war-room channel | Same Slack workspace reused across envs | Use separate Slack workspaces per env. Within one workspace, env-scope the channel prefix by adding `DEPLOYMENT_ENV` to `war-room-assembler.ts`'s `channelName` helper. |

For ongoing operation, see [`artifacts/runbook.md`](../artifacts/runbook.md). For every concrete error and its fix, see [`docs/troubleshooting.md`](troubleshooting.md).
