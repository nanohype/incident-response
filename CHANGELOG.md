# Changelog

All notable changes to incident-response are documented here. Dates use ISO 8601 (YYYY-MM-DD).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — until v1.0.0 any minor version can include breaking changes with a migration path documented in the release entry.

The internal service handle stays `incident-response`: the npm package, the OTel `service.namespace` / `agents.platform`, the `/incident-response` slash commands + Slack app, and the `incident-response/<env>/*` secret prefixes are all coupled to the landing-zone `incident-response-platform` substrate.

## [Unreleased]

## [0.1.0] — Initial standalone release

incident-response is a ceremonial incident commander assistant. It assembles P1 war rooms from Grafana OnCall alerts, keeps an approval-gated Statuspage pipeline, and drafts postmortems in Linear. It ships as a Platform tenant on the `eks-agent-platform` operator.

### Added

#### Runtime

- Webhook Deployment behind ingress-nginx ingests Grafana OnCall alerts: HMAC-SHA256 signature verification (timing-safe), Zod payload validation, idempotent DynamoDB write, and enqueue to SQS FIFO. HMAC secret cached by `VersionId` with a 5-min TTL and force-refresh on verification failure so a rotation race recovers without a pod restart.
- Processor Deployment runs Slack Bolt in socket mode as a single replica (`Recreate` strategy, 60s `terminationGracePeriodSeconds` for in-flight SQS drain), with a typed `CommandRegistry` and `EventRegistry`.
- `WarRoomAssembler` assembles a Slack private channel in ≤5 min: creates channel, resolves responders via parallel WorkOS directory + Grafana OnCall escalation lookup, attaches a Grafana Cloud context snapshot, pins a checklist, schedules a 15-min status nudge via EventBridge Scheduler.
- `/incident-response` slash commands: `help`, `status`, `silence`, `resolve`, `checklist`.
- `StatuspageApprovalGate.approveAndPublish()` — the only code path that calls `StatuspageClient.createIncident()`. Two-phase commit: write `STATUSPAGE_DRAFT_APPROVED` audit → strongly-consistent verify → publish. CI grep-gate prevents any other call site.
- `/incident-response resolve` — 9-step resolution flow: load incident, fetch recent commits (GitHub), generate postmortem via Bedrock (Claude Sonnet 4.6), create Linear issue, delete nudge schedule, post pulse-rating blocks, flip incident to RESOLVED, post resolution announcement, archive channel.
- Bedrock invocation logging is set to NONE at the account level (a landing-zone control) so IC↔AI conversations never reach CloudWatch.

#### Observability

- OpenTelemetry traces + metrics export via OTLP to the cluster `otel-collector.observability.svc.cluster.local:4318`, which forwards to Grafana Cloud Tempo + Mimir. No per-pod sidecars.
- App writes structured JSON (Pino) to stderr; the cluster log forwarder ships it to Grafana Cloud Loki. `.child({ incident_id })` correlation and W3C trace context propagated through SQS attributes.
- `prometheusrule.yaml` carries three SLO + reliability alerts (assembly P99, directory-lookup failure spike, Statuspage publish failures), reconciled into Mimir by the kube-prometheus-stack operator from eks-gitops.
- `grafana-dashboard.yaml` ships the dashboard as a ConfigMap (`grafana_dashboard: "1"`), auto-imported by the Grafana sidecar.

#### Tenant trio

- `chart/` — Helm chart: webhook Deployment + Service + Ingress, processor Deployment, shared ServiceAccount (IRSA via `aws.platformRoleArn`), default-deny NetworkPolicy, ExternalSecret, PrometheusRule, Grafana dashboard. Per-env deltas in `chart/values-{staging,production}.yaml`.
- `platform.yaml` — `Platform` CR + `BudgetPolicy` declaring incident-response as a tenant of the `protohype` team. The operator reconciles Namespace `tenants-protohype`, ResourceQuota, default-deny NetworkPolicy, ArgoCD AppProject, and the IRSA role.
- `gitops/applicationset-entry.yaml` — ApplicationSet entry registered into `nanohype/eks-gitops` for ArgoCD reconciliation.

#### Substrate (landing-zone `incident-response-platform`)

- DynamoDB `incident-response-{env}-incidents` with three GSIs (`event-type-index`, `incident-id-index`, `slack-channel-index` — resolves war-room channel → canonical incident_id for slash-command dispatch).
- DynamoDB `incident-response-{env}-audit` with a `published-without-approval-index` GSI for invariant auditing.
- SQS FIFO `incident-response-{env}-incident-events.fifo` + DLQ with `maxReceiveCount: 3`. Non-FIFO queues for nudges + SLA checks.
- EventBridge Scheduler group `incident-response-{env}` for per-incident nudges.
- S3 audit/artifacts bucket and the `incident_response_irsa` role. Outputs (`irsa_role_arn`, table names, queue URLs/ARN, scheduler role/group, bucket names) feed the chart via `tenantInfra.*` + `aws.platformRoleArn`.

#### Operator surface

- `scripts/seed-secrets.sh` — JSON-driven secret seeder with a `REQUIRED_KEYS` inventory. Blocks on any `REPLACE_ME` value.
- `scripts/fire-drill.sh` — HMAC-signed synthetic P1 webhook; exercises the full path without a real OnCall integration.
- `scripts/observe-incident.sh` — snapshot an incident's DDB row + audit trail + queue depths.
- `scripts/join-drill-channel.sh` — invite the drill runner to the freshest `incident-response-p1-*` channel via bot token.
- `scripts/ci-drill.sh` — CI-mode drill that fires, asserts audit events, archives the channel, cleans up.

#### Testing + CI

- 100% branch coverage enforced on `src/utils/audit.ts` and `src/services/statuspage-approval-gate.ts` (`jest.config.cjs` `coverageThreshold`).
- Integration tests against `amazon/dynamodb-local` for `ConsistentRead` semantics, idempotency, and cross-incident isolation.
- Unit suite covers HttpClient retry + timeout, circuit breaker state machine, HMAC cache invalidation, Slack adapter fail modes, Zod command-text validation.
- GH Actions `ci.yml`: lint + format:check, build, unit + coverage, integration (dynamodb-local service container), `npm audit`, `tsc --noEmit` (incl. tests), invariant grep-gates (Statuspage gate, Slack adapter, HTTP client, baked secrets, secret-inventory drift), `helm template` staging + production, Docker build.
- GH Actions `nightly-drill.yml`: scheduled canary drill against staging via GH OIDC. Asserts `ROOM_ASSEMBLED` + required audit events. Gated by the `INCIDENT_RESPONSE_DRILL_ENABLED` repo variable so it stays off until the OIDC role is provisioned.
- GH Actions `security.yml` (gitleaks + trivy, weekly) and `release.yml` (image build + cosign + SBOM, OCI push).

#### Documentation

- `README.md`, `CLAUDE.md`, `AGENTS.md`, `ARCHITECTURE.md`, `CHANGELOG.md`.
- `docs/deployment-guide.md`, `docs/slack-app-setup.md`, `docs/secrets.md`, `docs/drills.md`, `docs/troubleshooting.md`.
- `docs/forking-for-a-new-client.md` — bringing the app up against a different Slack workspace / Linear project / Statuspage / Grafana tenant without touching application code.

### Security

- HMAC-SHA256 verification with `crypto.timingSafeEqual` and version-aware cache invalidation on rotation race (`src/handlers/webhook-ingress.ts`).
- Zod validation at every system boundary (webhook payload + slash-command text + args).
- No secrets baked into images or manifests — the External Secrets Operator projects `incident-response/<env>/*` from AWS Secrets Manager into a k8s Secret consumed via `envFrom`.
- Audit scrubber (`src/utils/audit.ts:scrubDetails`) redacts secret-shaped field names with two-tier matching (substring for compounds, exact for bare `key`/`auth`/`cookie`).
- IAM least privilege — the IRSA role is scoped to specific resource ARNs + GSI paths; the staging role cannot read production secrets and vice versa.

[Unreleased]: https://github.com/nanohype/incident-response/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nanohype/incident-response/releases/tag/v0.1.0
