# Forking incident-response for a new client

This app is a self-contained service. Forking for a different client means swapping **runtime configuration** (secrets, DDB table names, Slack workspace, Linear project, Grafana tenant) — not editing business logic. Every external integration goes through a constructor-injected client, and every AWS resource carries an env-scoped prefix owned by the `landing-zone tenant-substrate` substrate.

Budget ~2 hours end-to-end: 30 min for third-party account setup, 30 min for local seed, 30 min for a clean deploy, 30 min for a drill.

## Before you start

Have ready:

- An AWS account + region you own (defaults to `us-west-2`; set `AWS_REGION` for the cluster + substrate).
- A cluster running the `eks-agent-platform` operator, with `kubectl` + `helm` context on it.
- Admin access to a Slack workspace where you can create an app.
- Access to Grafana Cloud (OnCall for the alert source, plus the Mimir/Loki/Tempo stack the war-room context snapshot reads) — a free tier works for drills. This is the app's upstream, not where its own telemetry lands: that goes to the cluster's OpenTelemetry Collector → Tempo / AMP / Loki.
- A Linear workspace with a project to hold postmortems.
- A Statuspage.io account — any tier. Use a test page for drills; publish goes there too.
- A WorkOS account (for directory sync). The free tier handles drill-volume lookups.
- A GitHub org + token with `repo:read` scope (for the resolve-time commit fetch).

## 1. Name the fork

The app carries the internal handle `incident-response` through:

- Secrets Manager path prefix (`incident-response/{env}/...`)
- DDB table names (`incident-response-{env}-incidents`, `incident-response-{env}-audit`)
- SQS queue names (`incident-response-{env}-incident-events.fifo`, etc.)
- EventBridge Scheduler group (`incident-response-{env}`)
- Slack channel prefix (`incident-response-p1-YYYYMMDD-*`)
- OTel `service.namespace` / `agents.platform` = `incident-response`
- The `/incident-response` slash command + Slack app name

The datastore names are declared in `spec.datastores` (DynamoDB tables, SQS queues, the S3 archive) and provisioned by the generic `tenant-substrate` component; the chart consumes them via `tenantInfra.*`. The EventBridge Scheduler grants + invoke role are operator-generated from the `eventBridgeScheduler` capability. If you want to rename — e.g. `sentinel` for your company — change the datastore names in `platform.yaml`, then a find-and-replace on `incident-response` (lowercase), `IncidentResponse` (PascalCase), and `INCIDENT_RESPONSE` (SCREAMING for env vars, audit `actor_user_id: 'INCIDENT_RESPONSE'`) covers the app side. Leave `incident-response-p1-` in Slack channel names if you want operators to recognize the convention.

## 2. Third-party account setup

### Slack app

Follow [`docs/slack-app-setup.md`](slack-app-setup.md) verbatim. You'll end up with:

- Bot token (`xoxb-…`)
- Signing secret

Register `/incident-response` as a slash command and point Interactivity + the slash-command Request URLs at your webhook host (`https://<webhook-host>/slack/{commands,interactivity}`). Socket Mode stays off.

### Grafana OnCall + Cloud

Follow [`docs/secrets.md`](secrets.md) § "Grafana Cloud numeric identifiers." You'll seed:

- `grafana/oncall-token` — OnCall API token or service-account `glsa_…`
- `grafana/cloud-token` — Mimir API token
- `grafana/cloud-org-id` — the Mimir tenant ID (not the instance ID, not the Loki ID)
- `grafana/oncall-webhook-hmac` — generate with `openssl rand -base64 32`
- `grafana-cloud/otlp-auth` — JSON blob with `instance_id`, `api_token`, `loki_username`, `loki_host`. Only read when telemetry export is repointed at an authenticated OTLP gateway; the default in-cluster collector endpoint needs no credential.

Create an OnCall outgoing-webhook integration later (after the first deploy — you'll need the webhook ingress hostname). Point it at `https://<ingress-host>/webhook/grafana-oncall` and paste the same HMAC secret you seeded above.

### Linear

Linear's API expects **UUIDs**, not team keys. Get them via:

```bash
LINEAR_KEY=$(cat incident-response-secrets.staging.json | jq -r '."linear/api-key"')
curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ teams { nodes { id key name } } projects(first: 50) { nodes { id name } } }"}' | jq '.data'
```

Seed:

- `linear/api-key` — personal API key or service OAuth token
- `linear/team-id` — team UUID (e.g. `a1b2c3d4-…`), not the short key
- `linear/project-id` — project UUID for postmortems

### Statuspage.io

Two secrets:

- `statuspage/api-key` — from your Statuspage profile → API Info
- `statuspage/page-id` — the short alpha-numeric ID in your page URL

**Use a dedicated drill page** (or a hidden page) for non-production drills. The approval gate is the last line of defence; even with it, a mis-seeded page ID would publish to the wrong audience.

### WorkOS

- `workos/api-key` — Dashboard → API Keys → Staging key

You'll need to configure Directory Sync for whichever IdP feeds your on-call rotation (Okta, Google, OneLogin, etc.). The app scopes lookups to one directory via `WORKOS_DIRECTORY_ID` (required) and reads directory groups via `WORKOS_TEAM_GROUP_MAP` env JSON — both set under the chart's `env.*` block in `chart/values-<env>.yaml`.

### GitHub

- `github/token` — a PAT with `repo:read` on the repos you want in postmortem deploy timelines. Set `GITHUB_ORG_SLUG` and `GITHUB_REPO_NAMES` under the chart's `env.*` block.

## 3. Seed secrets

Copy the template, fill it in, seed.

```bash
cp secrets.template.json incident-response-secrets.staging.json
# edit incident-response-secrets.staging.json — replace every REPLACE_ME
AWS_PROFILE=<yours> npm run seed:staging
```

The seeder blocks if any `REPLACE_ME` slips through. `incident-response-secrets.{env}.json` is in `.gitignore` — do not commit it.

## 4. Deploy

Apply the `landing-zone tenant-substrate` substrate for the env, fill `chart/values-staging.yaml` from its `tofu output`, then bring the tenant up:

```bash
npm install
npm run check              # typecheck + lint + format:check + unit tests
kubectl apply -f platform.yaml                       # tenant boundary
kubectl -n tenants-reliability get platform incident-response -w # wait Ready
# register gitops/applicationset-entry.yaml in eks-gitops → ArgoCD rolls it out
kubectl -n tenants-incident-response rollout status deploy/incident-response-processor
```

Full step-by-step in [`docs/deployment-guide.md`](deployment-guide.md). Confirm the webhook HMAC gate is live (unsigned POST → `401`) and the DLQ depth is zero before wiring real alerts.

## 5. Wire Grafana OnCall

Use the webhook ingress hostname for the env — `ingress.host` in `chart/values-{env}.yaml`, published to Route53 by external-dns. HTTPS is terminated by the ALB, so that host needs an ACM certificate covering it: set `ingress.tls.certificateArn` to an ARN from the landing-zone `dns` component (`terragrunt output -json acm_certificate_arns`), or leave it empty and the AWS Load Balancer Controller matches one in ACM by domain. Nothing issues a certificate in-cluster — a host with no ACM match will fail the TLS handshake. In your Grafana OnCall:

- Outgoing webhooks → Create
- URL: `https://<ingress-host>/webhook/grafana-oncall`
- Method: POST
- Signing secret: paste the same `grafana/oncall-webhook-hmac` value you seeded
- Trigger: Alert group firing

## 6. Fire a drill

The drill signs with one environment's HMAC secret and has to prove it is reaching that environment's load balancer and no other, so it needs a webhook hostname for *every* environment before it fires — `ingress.host` in each `chart/values-<env>.yaml`, or `DRILL_WEBHOOK_HOST_<ENV>`, or `DRILL_WEBHOOK_HOST_<ENV>=none` for one your fork does not deploy. `bash scripts/fire-drill.sh --env staging --check-target` prints the map and says what is missing without contacting anything.

```bash
npm run drill:staging
npm run drill:join:staging -- --user <your Slack member ID>
# in the war room: /incident-response status draft → approve → /incident-response resolve
npm run observe:staging   # inspect audit trail
```

If the Slack channel lands, the audit trail shows `ROOM_ASSEMBLED`, and `/incident-response resolve` produces a Linear issue + archives the channel, the fork is working.

## 7. Production when you're ready

```bash
npm run seed:production
# fill chart/values-production.yaml from the production tenant-substrate tofu output,
# register the production ApplicationSet env, let ArgoCD roll it out
npm run chart:template:production   # render + sanity-check before commit
```

The production tenant is identical in shape; only IAM scoping and the substrate's data-retention policy (DDB `RETAIN`) differ — both owned by `landing-zone`.

## What you should NOT touch

- `src/services/statuspage-approval-gate.ts` — the security invariant. If you change it, CI fails on the grep-gate.
- `src/utils/audit.ts` — 100% branch coverage is enforced; any regression fails CI.
- The account-level Bedrock invocation-logging=NONE control — owned by `landing-zone`, not app code. Keep it in place so IC↔AI conversations never reach CloudWatch.

## What you might want to change

- **Channel name format** (`src/services/war-room-assembler.ts:channelName`) — currently `incident-response-p1-YYYYMMDD-<id-prefix>-<nonce>`. Change the prefix, not the nonce (the nonce prevents collisions).
- **Checklist items** (`src/services/war-room-assembler.ts:CHECKLIST_ITEMS`) — the 11 defaults cover a generic SaaS P1; your team may want org-specific items (SOC-2 incident reporting, legal notification, PR coordination).
- **Nudge cadence** (`src/services/nudge-scheduler.ts:ScheduleExpression`) — defaults to `rate(15 minutes)`. Longer for low-velocity incidents, shorter for a demanding IC culture.
- **Bedrock model IDs** (`src/ai/incident-response-ai.ts:SONNET_MODEL_ID`, `HAIKU_MODEL_ID`) — use cross-region inference profile IDs like `us.anthropic.claude-sonnet-4-6` if on-demand throughput on the raw model ID isn't available in your account.

## Support contract

Treat the code as yours after forking — there's no upstream sync path. Pull design ideas, not code.
