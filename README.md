# incident-response

![Build](https://github.com/nanohype/incident-response/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/License-Apache--2.0-green)
![Node](https://img.shields.io/badge/Node-%3E%3D24-339933?logo=node.js)
![Kubernetes](https://img.shields.io/badge/Kubernetes-Tenant-326CE5?logo=kubernetes)

Ceremonial incident commander assistant for mid-enterprise SaaS. Cuts median P1 alert-to-war-room-assembled from ~20 minutes to ≤5 minutes. 100% IC-approval gate on all customer-facing status messages. Postmortem draft in Linear within 2 minutes of resolution. The internal service handle is `incident-response` (npm package, OTel `service.namespace` / `agents.platform`, the `/incident-response` slash commands + Slack app, and the `incident-response/<env>/*` secret prefixes).

**AI clients / agents start here:** [`AGENTS.md`](AGENTS.md). For the stack-wide view, see the [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md).

## What This Is

A protohype project composing nanohype templates (ts-service, infra-aws, agentic-loop, prompt-library, module-llm) into a long-running Slack-socket-mode daemon. A webhook Deployment behind ingress-nginx ingests Grafana OnCall alerts; a processor Deployment runs the Slack socket-mode singleton.

**Not a template** — this is a standalone service. Helm chart in `chart/`, app code in `src/`, test suites in `test/`, and the authoritative artifact set in `artifacts/`.

## How It Works

```
Grafana OnCall webhook ──► ingress-nginx ──► webhook Deployment (HMAC verify, idempotent DDB write)
                                                │
                                                ▼
                                     SQS FIFO (incident-events)
                                                │
                                                ▼
                      processor Deployment ── Slack socket-mode (singleton, Recreate)
                     │   ├── WarRoomAssembler (WorkOS + Grafana OnCall + Grafana Cloud, parallel)
                     │   ├── StatuspageApprovalGate (two-phase commit, ConsistentRead:true)
                     │   ├── NudgeScheduler (EventBridge Scheduler, 15-min)
                     │   └── CommandRegistry (/incident-response status|resolve|silence|checklist|help)
                     │
                     ▼
                DynamoDB (incident-response-incidents + incident-response-audit; PITR on, 366-day TTL)
```

**Core invariant:** `StatuspageApprovalGate.approveAndPublish()` is the ONLY code path that may call `StatuspageClient.createIncident()`. Enforced at three layers:
1. **Application** — IC must click "Approve & Publish" in Slack Block Kit (with confirmation dialog).
2. **Database** — `verifyApprovalBeforePublish()` queries `incident-response-audit` with `ConsistentRead: true` before any Statuspage API call; throws `AutoPublishNotPermittedError` if the approval event is absent.
3. **CI** — `.github/workflows/ci.yml` greps for `createIncident()` outside the gate file and fails the build if any new call site appears. Plus grep-gates for: no `new WebClient` outside the adapter, no bare `fetch()` outside the HTTP client, no secrets baked into images or manifests (ExternalSecret only), and a secret-inventory drift check across the seeder, `secrets.template.json`, and the chart's `externalsecret.yaml` remoteRefs.

## Architecture

- **src/handlers/webhook-ingress.ts** — the webhook ingress handler (served by the webhook Deployment). HMAC-SHA256 verify (timing-safe), Zod payload validation, idempotency via DynamoDB conditional write, enqueue to SQS FIFO. HMAC secret cached by `VersionId` with 5-min TTL + force-refresh on verification failure (handles rotation race).
- **src/services/war-room-assembler.ts** — Assembles the incident war room: creates Slack private channel, resolves responders via WorkOS Directory Sync + Grafana OnCall escalation chain, attaches Grafana Cloud (Mimir/Loki/Tempo) context snapshot, pins checklist, schedules 15-min nudges. Per-call Slack timeouts via `withTimeoutOrDefault` so a wedged Slack call can't stall assembly.
- **src/services/statuspage-approval-gate.ts** — Two-phase commit: write `STATUSPAGE_DRAFT_APPROVED` → `verifyApprovalBeforePublish` (ConsistentRead) → Statuspage.io createIncident → write `STATUSPAGE_PUBLISHED`. 100% branch coverage enforced.
- **src/services/nudge-scheduler.ts** — Per-incident EventBridge Scheduler rules (survive pod restarts). IC silence → DISABLED, not deleted, plus audit event.
- **src/services/sqs-consumer.ts** — Long-polling consumer for incident + nudge queues; DLQ-safe (no delete on failure).
- **src/services/command-registry.ts**, **src/services/event-registry.ts** — Typed dispatchers. Adding a slash command or SQS event type = one handler file + one registry line; no edits to `index.ts`.
- **src/commands/** — One file per `/incident-response` subcommand (`status`, `resolve`, `silence`, `checklist`, `help`). `resolve.ts` drives the full 9-step resolution: load incident → fetch recent commits → Bedrock postmortem → Linear issue create → delete nudge → pulse-rating blocks → flip status + audit → public announcement → archive channel. Channel-scoped commands (`status`, `checklist`, `silence`, `resolve`) resolve channel → incident via the `slack-channel-index` GSI in `src/utils/incident-lookup.ts`; `help` works from any channel.
- **src/events/** — One file per SQS event type (`ALERT_RECEIVED`, `ALERT_RESOLVED`, `STATUS_UPDATE_NUDGE`, `SLA_CHECK`).
- **src/clients/** — Thin adapters: `workos-client` (Directory Sync REST API with 5-min cache, stale fallback, cursor pagination via `list_metadata.after`, capped at 50 pages / 5k members — concrete implementation of the IdP-neutral `DirectoryUser` port), `grafana-oncall-client`, `grafana-cloud-client` (read-only, hard-coded), `statuspage-client`, `linear-client` (@linear/sdk), `github-client` (CODEOWNERS + recent commits for deploy timeline).
- **src/ai/incident-response-ai.ts** — Bedrock wrapper. `claude-sonnet-4-6` for drafts + postmortems, `claude-haiku-4-5` for message classification. Anthropic prompt caching on system prompts. PII stripping (emails, account IDs, IPs, internal hostnames) applied BEFORE Bedrock calls.
- **src/utils/http-client.ts** — 5-second hard timeout, 2-retry hard cap, exponential backoff with jitter. AbortController-backed.
- **src/utils/metrics.ts** — OTel Metrics API (`assembly_duration_ms`, `approval_gate_latency_ms`, `directory_lookup_failure_count`, `statuspage_publish_count{outcome}`, `incident_resolved_count`, `postmortem_created_count`). Exported via OTLP to the cluster `grafana-agent.monitoring.svc.cluster.local:4318`, which forwards to Grafana Cloud Mimir. Non-blocking.
- **src/utils/tracing.ts** — OTel tracing helpers: `withSpan` wrapper, SQS MessageAttributes ↔ W3C trace-context helpers. Auto-instrumentation wires up http/fetch/aws-sdk; manual spans in `WarRoomAssembler.assemble` give per-step timings (create_channel, resolve_responders, invite_responders, post_context, pin_checklist, schedule_nudge). Trace context propagates across the webhook Deployment → SQS → processor Deployment hop.
- **src/utils/logger.ts** — Structured JSON logger (stdout/stderr). Stamps `trace_id` + `span_id` from the active OTel span when present so Grafana's Tempo → Loki jump works one-click. Both Deployments write JSON to stderr; the cluster log forwarder ships it to Grafana Cloud Loki. No per-pod sidecars.
- **src/utils/audit.ts** — Audit log writer. All writes AWAITED. ConditionExpression `attribute_not_exists(SK)` for idempotency. Ships with `auditApprovalGateViolations()` for compliance sweeps.
- **src/utils/with-timeout.ts** — Generic `withTimeout` + `withTimeoutOrDefault` helpers. Used around non-critical Slack calls.
- **chart/** — Helm chart: webhook Deployment + Service + public Ingress (the `node:http` wrapper at `src/bin/webhook-server.ts`), processor Deployment (Slack socket-mode singleton, Recreate strategy), shared ServiceAccount named `incident-response`, bound to the landing-zone `incident-response-platform` IAM role by an EKS Pod Identity association (no role-arn annotation), NetworkPolicy (ingress-nginx → webhook + egress DNS + HTTPS), ExternalSecret aggregating `grafana-oncall-hmac` + `app-secrets` + `grafana-cloud`, PrometheusRule with three SLO alerts, Grafana dashboard ConfigMap. See [`chart/README.md`](chart/README.md) for the full template-by-template description.
- **platform.yaml** — Platform CR (`platform.nanohype.dev/v1alpha1`) declaring incident-response as a tenant of the `protohype` team, with a co-declared BudgetPolicy (`governance.nanohype.dev/v1alpha1`; $2500/mo soft cap, kill-switch on, alerts at 50/80/100%). `identity.allowedModelFamilies: ["anthropic"]` for Bedrock access on the operator-reconciled IAM role (used by AgentFleet pods if/when any land); incident-response's own app pods assume the landing-zone-owned role directly via the EKS Pod Identity association.
- **gitops/applicationset-entry.yaml** — ApplicationSet entry for `nanohype/eks-gitops` ArgoCD reconciliation.
- **src/bin/webhook-server.ts** — `node:http` wrapper that mounts the `APIGatewayProxyHandlerV2` from `src/handlers/webhook-ingress.ts` on a POST endpoint plus `/health` for k8s probes. This is the entrypoint the webhook Deployment runs. No new runtime dependencies.

## Run locally

```bash
npm install
cp .env.example .env   # fill in values — see "Configuration" below
npm run dev            # ts-node-dev against local Slack socket-mode
```

`npm run dev` expects live Slack socket-mode credentials (use a test workspace + bot app during development). DynamoDB + SQS URLs can point at staging resources; there is no local-only mode for the production integrations.

## Test

```bash
npm test                           # all suites (unit + integration)
npm run test:unit                  # unit — adapters, breaker, audit, approval gate, handlers
npm run test:integration           # requires dynamodb-local on :8000
npm run test:integration:docker    # spins up Docker container, runs integration, cleans up
npm run typecheck
npm run lint
npm run format:check
npm run check                      # typecheck + lint + format:check + test:unit (CI parity)
```

`audit.ts` and `statuspage-approval-gate.ts` are locked at 100% branches / lines / functions — CI fails on any regression there. See [§ Testing](#testing) for the Kent-Dodds-trophy distribution + the proof-of-enforcement experiment.

## Build

```bash
npm run build                      # tsc → dist/
```

## Deploy

Renders as a Platform tenant on the [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) operator. The chart produces two workloads (webhook Deployment with public ingress for the Grafana OnCall HMAC POSTs, processor Deployment in Recreate strategy for the Slack socket-mode singleton) plus a PrometheusRule for the three SLO alerts and a Grafana dashboard ConfigMap. Telemetry ships to Grafana Cloud via the cluster-level OTel Collector + log forwarder installed by `eks-gitops` — no per-pod sidecars.

Secrets Manager entries are operator-provisioned via `npm run seed:{env}` and consumed at runtime via the External Secrets Operator — no secrets bake into images or manifests; the ExternalSecret projects `incident-response/<env>/*` into one k8s Secret consumed via `envFrom`. Resource names, secret paths, IAM policies, and the OTel `deployment.environment` attribute are all env-scoped (`incident-response/staging/*` vs `incident-response/production/*`). The staging IAM role cannot read production secrets and vice versa.

```bash
npm run chart:lint                   # helm lint chart
npm run chart:template:staging       # render chart with staging values
npm run chart:template:production
npm run seed:staging                 # seed Secrets Manager entries

# ArgoCD owns the rollout — bump image.tag in chart/values-{env}.yaml,
# commit, push. Initial tenant setup follows chart/README.md
# (apply platform.yaml → wait Ready → register ApplicationSet entry).
```

First-time deployers should stand staging up, run the scripted drill (`npm run drill:staging`), then Drill 2 from [`artifacts/incident-drill-playbook.md`](artifacts/incident-drill-playbook.md) **before** rolling out to production.

**Forking IncidentResponse for a different client** — swap secrets, Slack workspace, Linear project, Grafana tenant without touching application code — [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

**First-time setup:** staging-first walkthrough covering AWS prerequisites (Bedrock model access + inference-profile caveat), per-env third-party accounts, Secrets Manager seeding (note: `linear/team-id` must be a UUID, not a team key), Grafana OnCall webhook wiring, and the promotion path to production — [`docs/deployment-guide.md`](docs/deployment-guide.md).

**Secret seeding + rotation** — env-scoped inventory (`incident-response/staging/*`, `incident-response/production/*`), `put-secret-value` commands, rotation cadence — [`docs/secrets.md`](docs/secrets.md).

**Nightly drill** — `.github/workflows/nightly-drill.yml` fires `scripts/ci-drill.sh` against staging on a schedule (and on-demand via `workflow_dispatch`). Guarded by the `INCIDENT_RESPONSE_DRILL_ENABLED` repo variable — stays off until you've wired the OIDC role.

## Configuration

All configuration via env vars. Required vars are asserted by `src/utils/env.ts` at startup; defaulted vars are parsed by the zod-validated config in `src/config/`. In production, secret values come from AWS Secrets Manager, projected by the ExternalSecret into a k8s Secret consumed via `envFrom`; `.env.example` is for local dev only. See [`docs/secrets.md`](docs/secrets.md) for the full inventory + provenance.

| Variable | Source | Purpose |
|----------|--------|---------|
| `SLACK_BOT_TOKEN` | secret `incident-response/slack/bot-token` | Slack bot OAuth (chat:write, channels:manage, etc.) |
| `SLACK_SIGNING_SECRET` | secret `incident-response/slack/signing-secret` | Slack request signature verification |
| `SLACK_APP_TOKEN` | secret `incident-response/{env}/slack/app-token` | Slack app-level socket-mode token (`xapp-…`) |
| `GRAFANA_ONCALL_TOKEN` | secret `incident-response/grafana/oncall-token` | Grafana OnCall REST API (read-only) |
| `GRAFANA_CLOUD_TOKEN`, `GRAFANA_CLOUD_ORG_ID` | secrets `incident-response/grafana/cloud-token`, `.../cloud-org-id` | Mimir/Loki/Tempo (read-only) |
| `STATUSPAGE_API_KEY`, `STATUSPAGE_PAGE_ID` | secrets `incident-response/statuspage/api-key`, `.../page-id` | Statuspage.io |
| `LINEAR_API_KEY`, `LINEAR_PROJECT_ID`, `LINEAR_TEAM_ID` | secret `incident-response/linear/*` | Linear postmortem destination |
| `WORKOS_API_KEY`, `WORKOS_TEAM_GROUP_MAP` | key in ExternalSecret; map from chart `env.*` | WorkOS Directory Sync — responder resolution |
| `GITHUB_TOKEN`, `GITHUB_ORG_SLUG`, `GITHUB_REPO_NAMES` | token from ExternalSecret; rest from chart `env.*` | Deploy-timeline enrichment for postmortems |
| `INCIDENTS_TABLE_NAME`, `AUDIT_TABLE_NAME` | from chart `tenantInfra.*` (landing-zone output) | DynamoDB table names |
| `INCIDENT_EVENTS_QUEUE_URL`, `NUDGE_EVENTS_QUEUE_URL`, `SLA_CHECK_QUEUE_URL` | from chart `tenantInfra.*` (landing-zone output) | SQS URLs |
| `SCHEDULER_ROLE_ARN`, `AWS_REGION` | from chart `tenantInfra.*` (landing-zone output) | EventBridge Scheduler |
| `GRAFANA_ONCALL_HMAC_SECRET_ID` | from chart `externalSecret.hmacSecret` | name of `incident-response/<env>/grafana-oncall-hmac` — the handler fetches the value dynamically so rotation doesn't require a pod restart |
| `BEDROCK_SONNET_MODEL_ID`, `BEDROCK_HAIKU_MODEL_ID` | optional; defaults in `src/config/` | Bedrock model IDs (Sonnet drafts, Haiku classifies) — override to pin a snapshot or cross-region inference profile |

The JSON-shaped secret `incident-response/{env}/grafana-cloud/otlp-auth` carries the Grafana Cloud telemetry credentials in one payload. Operator-provisioned like every other secret — the seeder auto-computes `basic_auth` from `instance_id` + `api_token` if you omit it from the JSON. The cluster OTel Collector + log forwarder (eks-gitops) own the export path; the app just emits OTLP + JSON. See [`docs/secrets.md`](docs/secrets.md) § "The `incident-response/{env}/grafana-cloud/otlp-auth` secret".

## Dashboards + alerts

Both ship as Kubernetes resources from the chart — no manual import step. The PrometheusRule in `chart/templates/prometheusrule.yaml` carries three alerts (assembly P99 > 5min, directory-lookup failure spike, Statuspage publish failures) and is reconciled into Mimir by the kube-prometheus-stack operator sidecar that ships with `eks-gitops`. The Grafana dashboard ConfigMap in `chart/templates/grafana-dashboard.yaml` is sourced from `chart/dashboards/incident-response.json` and auto-imported by the Grafana sidecar via the `grafana_dashboard: "1"` label selector.

## Conventions

Per root `protohype/CLAUDE.md`: TypeScript, ESM (`.js` import suffixes), Node 24, 2-space indent, strict TS (`exactOptionalPropertyTypes: true`), Zod at system boundaries, structured JSON logging to stderr/stdout, Vitest for tests, ESLint + typescript-eslint.

IncidentResponse-specific:
- **Ubiquitous language.** `WarRoomAssembler`, `StatuspageApprovalGate`, `NudgeScheduler`, `CommandRegistry` — not `DataProcessor` or `ExternalServiceAdapter`.
- **Registry over switch.** Slash commands and SQS events dispatch through `CommandRegistry` / `EventRegistry`. `src/index.ts` stays under 80 LOC.
- **No silent stubs.** Any command that doesn't drive its action to completion must say so to the user explicitly. `respond({ text: 'triggered' })` without actually triggering is a bug.
- **Metric failures never block flow.** `MetricsEmitter` swallows errors into warn logs. Operational visibility degrades; incident flow doesn't.

## Testing

Unit suite covers adapters, circuit breaker, audit writer, approval gate, command/event registries, HMAC cache, tracing propagation, Slack validation. Integration suite hits `amazon/dynamodb-local` for `ConsistentRead` semantics, idempotency, and cross-incident isolation. `npm run test:unit` runs on every PR; integration runs as a separate CI job with a DDB-local service container.

### Coverage thresholds

| File | Branches | Functions | Lines |
|------|----------|-----------|-------|
| `src/utils/audit.ts` | **100%** | **100%** | **100%** |
| `src/services/statuspage-approval-gate.ts` | **100%** | **100%** | **100%** |
| global | 55% | 75% | 75% |

Security-critical thresholds are load-bearing — they gate the approval-gate invariant. Global thresholds reflect the current test surface; expanding coverage to 80/85 is tracked as a follow-up.

### Proving enforcement is live

Thresholds that never fail are ceremonial. To prove the 100% gate actually blocks CI, flip one branch in `src/utils/audit.ts` (e.g. change `ConsistentRead: true` to `false`) and run `npm run test:unit`. Expected outcome: `Vitest exit code: 1`, `AUDIT-006: uses ConsistentRead: true` fails. Restore, re-run: exit 0. This experiment is in the PR comment history and should be re-run whenever the threshold config changes.

### Adding tests

- Unit tests: mock external dependencies. Critical invariants (audit integrity, approval-gate sequencing) stay in the 100%-threshold files.
- Integration tests: use the real `AuditWriter` against dynamodb-local. The dynamodb-local container is for tests that would be meaningless against mocks — `ConsistentRead` semantics, `ConditionExpression` enforcement, GSI projections.

## Dependencies

- `@slack/bolt` + `@slack/web-api` — Slack socket mode + Web API.
- `@aws-sdk/client-*` — DynamoDB, SQS, Secrets Manager, Scheduler, Bedrock, Bedrock Runtime.
- `@opentelemetry/api` + `@opentelemetry/auto-instrumentations-node` + `@opentelemetry/sdk-node` — tracing + metrics via OTLP. Traces land in Grafana Cloud Tempo; metrics in Mimir.
- `@linear/sdk` — postmortem issue creation.
- `zod` — webhook payload validation.
- `aws-sdk-client-mock` + `aws-sdk-client-mock-vitest` — AWS SDK mocks + custom matchers for unit tests.

## Boundaries

This repo owns the application — the incident pipeline, the war-room assembly, the approval-gate invariant, and the tenant trio that deploys it. It does **not** own:

- AWS substrate (DynamoDB tables, SQS + DLQ, EventBridge Scheduler group, S3 audit/artifacts bucket, the `incident_response_irsa` role) → the `incident-response-platform` component in [`landing-zone`](https://github.com/nanohype/landing-zone). Its outputs feed the chart via `tenantInfra.*`.
- Account-level controls (Bedrock invocation-logging=NONE) → also a `landing-zone` responsibility, not app code.
- Cluster addons (ingress-nginx, cert-manager, external-secrets, the OTel collector + log forwarder, kube-prometheus-stack) → [`eks-gitops`](https://github.com/nanohype/eks-gitops).

## Artifacts + reference docs

Operator-facing:

| Document | Path |
|----------|------|
| Deployment guide (step-by-step, first-time) | [docs/deployment-guide.md](docs/deployment-guide.md) |
| Slack app setup (one-time per env) | [docs/slack-app-setup.md](docs/slack-app-setup.md) |
| Secrets inventory + seeding + rotation | [docs/secrets.md](docs/secrets.md) |
| Drills + "how do I see it work" | [docs/drills.md](docs/drills.md) |
| Troubleshooting catalogue | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Forking IncidentResponse for a new client | [docs/forking-for-a-new-client.md](docs/forking-for-a-new-client.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |
| SRE Runbook (day-2, incident response) | [artifacts/runbook.md](artifacts/runbook.md) |
| Incident Drill Playbook (tabletop + live-fire) | [artifacts/incident-drill-playbook.md](artifacts/incident-drill-playbook.md) |
| Seed secrets from JSON | [scripts/seed-secrets.sh](scripts/seed-secrets.sh) |
| Synthetic webhook drill | [scripts/fire-drill.sh](scripts/fire-drill.sh) |
| Incident-state observer | [scripts/observe-incident.sh](scripts/observe-incident.sh) |
| Invite yourself to a drill channel | [scripts/join-drill-channel.sh](scripts/join-drill-channel.sh) |
| CI drill (used by the nightly workflow) | [scripts/ci-drill.sh](scripts/ci-drill.sh) |

Design / scoping:

| Document | Path |
|----------|------|
| PRD | [artifacts/prd-incident-response.md](artifacts/prd-incident-response.md) |
| Architecture | [artifacts/architecture.md](artifacts/architecture.md) |
| Test Plan | [artifacts/test-plan.md](artifacts/test-plan.md) |
| Security Threat Model | [artifacts/threat-model.md](artifacts/threat-model.md) |
