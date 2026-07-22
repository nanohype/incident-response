# Changelog

All notable changes to incident-response are documented here. Dates use ISO 8601 (YYYY-MM-DD).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — until v1.0.0 any minor version can include breaking changes with a migration path documented in the release entry.

The app token is `incident-response` (npm package, image, OTel `service.namespace` / `agents.platform`, the `/incident-response` slash commands + Slack app, the `incident-response/<env>/*` secret prefixes, the landing-zone `incident-response-platform` substrate). The owning team is `reliability` (`Platform.spec.tenant`, OTel `agents.tenant`).

## [Unreleased]

### Changed

- `scripts/fire-drill.sh` establishes every environment's webhook host before it resolves a target, from one identity map built out of `DRILL_WEBHOOK_URL_<ENV>`, `DRILL_WEBHOOK_HOST_<ENV>` and `chart/values-<env>.yaml` (falling back to `chart/values.yaml`). An environment whose host cannot be established, two sources that name it differently, and two environments that claim one host are each a refusal that prints the map and what to configure — a drill that cannot prove where it is firing does not fire. An environment with no webhook deployment is declared with `DRILL_WEBHOOK_HOST_<ENV>=none`, and every run that leans on such a declaration says so on stderr.
- `scripts/fire-drill.sh --check-target` prints the identity map, the resolved request and the secret id, and exits non-zero with the reason when a drill would not fire where it signs. It contacts nothing and needs no credentials. `.github/workflows/drill.yml` runs it as its whole preflight verdict and derives no hostnames of its own; `--canonical-host`, which existed for the workflow to compare with, is gone with it.
- Drill runs need a webhook hostname for every environment, not only the one being drilled: `INCIDENT_RESPONSE_DRILL_HOST_{DEVELOPMENT,STAGING,PRODUCTION}` for a fork whose values files still carry the shipped placeholder.
- `scripts/fire-drill.sh` constructs its request URL from four validated components — a fixed `https` scheme, the host the identity map established, a port checked as digits in range, and `ingress.path` — instead of concatenating source strings. No caller-supplied string reaches the authority position. `ingress.path` is refused for `@`, `?`, `#`, `%`, a backslash, whitespace, a control character, an empty segment, a `.`/`..` segment or a leading `//`, and what survives is percent-encoded per segment. `--url` carrying a path, a query, a fragment, userinfo or an `http` scheme is refused rather than partly honoured, and an authority carrying anything after its host is refused whichever source it came from.
- `scripts/fire-drill.sh` parses the URL it assembled with node's `new URL()` before anything is sent, and refuses unless the scheme, `hostname`, `port` and `pathname` are the components that went in and `username`/`password` are empty. Ports compare with no port and `443` read as one value, since the scheme is fixed at https and a parser prints the shorter spelling — an environment declared as `host:443` drills like any other. The host comparison is documented for what it establishes: that the assembly did not move the authority, not that the host belongs to the environment being drilled, and the component is additionally held to reading as nothing but a host. After the POST it re-parses curl's `%{url_effective}` and reports a host that is not the host every check ran on as a defect in the script — the request has already left by then, so this catches a defeated preflight rather than preventing one. node is now required in every mode, `.github/workflows/drill.yml` pins it, and curl runs with `--proto '=https'`.
- An environment's identity in `scripts/fire-drill.sh` is a host and a port. Both are established from the same three sources, both are reported in the identity map, and two sources that agree on the hostname and name different ports conflict exactly as two hostnames do. The resolved target is held against both, so `--host webhook.acme.io:19011` against a production environment declared at `:19013` refuses instead of delivering. Cross-environment collision stays a hostname comparison: two environments behind one hostname on two ports are still two that a DNS record, a certificate and a load balancer cannot tell apart.
- `scripts/fire-drill.sh --print-url` prints the whole request URL, for callers that need the part a hostname leaves out. `--print-host` keeps printing the hostname alone — widening it to `host:port` would break callers feeding it to a DNS lookup — and naming more than one of `--check-target`, `--print-host` and `--print-url` in a run is refused rather than resolved by flag order.
- `--host` and `DRILL_WEBHOOK_HOST_<ENV>` refuse a value carrying userinfo, the way `--url` and `DRILL_WEBHOOK_URL_<ENV>` already do. Everything before an `@` is userinfo and everything after it is the host, so a bare-host value carrying one names a different host to a text comparison than to whatever connects.
- The HMAC secret id is held against the other environments' trees with letter case folded, the way every host comparison in the script is: `incident-response/STAGING/...` names the staging tree exactly as `incident-response/staging/...` does, and is refused under `--env production` the same way.

## [0.1.0] — Initial standalone release

incident-response is a ceremonial incident commander assistant. It assembles P1 war rooms from Grafana OnCall alerts, keeps an approval-gated Statuspage pipeline, and drafts postmortems in Linear. It ships as a Platform tenant on the `eks-agent-platform` operator.

### Added

#### Runtime

- Webhook Deployment behind an internet-facing ALB ingests Grafana OnCall alerts: HMAC-SHA256 signature verification (timing-safe), Zod payload validation, idempotent DynamoDB write, and enqueue to SQS FIFO. HMAC secret cached by `VersionId` with a 5-min TTL and force-refresh on verification failure so a rotation race recovers without a pod restart.
- Processor Deployment runs the SQS consumer, war-room assembler, nudge scheduler and in-process MCP server as a single-writer singleton (`replicas: 1`, `Recreate` strategy, 60s `terminationGracePeriodSeconds` for in-flight SQS drain), with a typed `CommandRegistry` and `EventRegistry`.
- `WarRoomAssembler` assembles a Slack private channel in ≤5 min: creates channel, resolves responders via parallel WorkOS directory + Grafana OnCall escalation lookup, attaches a Grafana Cloud context snapshot, pins a checklist, schedules a 15-min status nudge via EventBridge Scheduler.
- `/incident-response` slash commands: `help`, `status`, `silence`, `resolve`, `checklist`.
- `StatuspageApprovalGate.approveAndPublish()` — the only code path that calls `StatuspageClient.createIncident()`. Two-phase commit: write `STATUSPAGE_DRAFT_APPROVED` audit → strongly-consistent verify → publish. CI grep-gate prevents any other call site.
- `/incident-response resolve` — 9-step resolution flow: load incident, fetch recent commits (GitHub), generate postmortem via Bedrock (Claude Sonnet 4.6), create Linear issue, delete nudge schedule, post pulse-rating blocks, flip incident to RESOLVED, post resolution announcement, archive channel.
- Bedrock invocation logging is set to NONE at the account level (a landing-zone control) so IC↔AI conversations never reach CloudWatch.

#### Observability

- OpenTelemetry traces + metrics export via OTLP to Grafana Alloy in the `monitoring` namespace, which forwards traces to the in-cluster Tempo and SigV4 remote-writes metrics to Amazon Managed Prometheus. No per-pod sidecars.
- App writes structured JSON (Pino) to stderr; Grafana Alloy tails the pods and ships it to the in-cluster Loki. `.child({ incident_id })` correlation and W3C trace context propagated through SQS attributes.
- `prometheusrule.yaml` carries three SLO + reliability alerts (assembly P99, directory-lookup failure spike, Statuspage publish failures). Off by default — eks-gitops installs the prometheus-operator CRDs but no operator, so the CR applies and sits inert there.
- `grafana-dashboard.yaml` ships the dashboard as a `GrafanaDashboard` CR the grafana-operator reconciles onto the org Grafana instance.

#### Tenant trio

- `chart/` — Helm chart: webhook Deployment + Service + Ingress, processor Deployment, shared ServiceAccount (Pod Identity), default-deny NetworkPolicy, ExternalSecret, PrometheusRule, Grafana dashboard. Per-env deltas in `chart/values-{staging,production}.yaml`.
- `platform.yaml` — cluster-scoped `Tenant` CR for the `reliability` team plus the `Platform` CR + `BudgetPolicy` declaring incident-response as a tenant of it. The operator provisions the workload namespace `tenants-incident-response`, ResourceQuota, default-deny NetworkPolicy, the ArgoCD AppProject, and the IAM role.
- `gitops/applicationset-entry.yaml` — ApplicationSet entry registered into `nanohype/eks-gitops` for ArgoCD reconciliation.

#### Substrate (landing-zone `incident-response-platform`)

- DynamoDB `incident-response-{env}-incidents` with three GSIs (`event-type-index`, `incident-id-index`, `slack-channel-index` — resolves war-room channel → canonical incident_id for slash-command dispatch).
- DynamoDB `incident-response-{env}-audit` with a `published-without-approval-index` GSI for invariant auditing.
- SQS FIFO `incident-response-{env}-incident-events.fifo` + DLQ with `maxReceiveCount: 3`. Non-FIFO queues for nudges + SLA checks.
- EventBridge Scheduler group `incident-response-{env}` for per-incident nudges.
- S3 audit/artifacts bucket and the app IAM role, bound to the chart's ServiceAccount by an EKS Pod Identity association. Outputs (table names, queue URLs/ARN, scheduler role/group, bucket names) feed the chart via `tenantInfra.*`.

#### Operator surface

- `scripts/seed-secrets.sh` — JSON-driven secret seeder with a `REQUIRED_KEYS` inventory. Blocks on any `REPLACE_ME` value.
- `scripts/fire-drill.sh` — HMAC-signed synthetic P1 webhook; exercises the full path without a real OnCall integration.
- `scripts/observe-incident.sh` — snapshot an incident's DDB row + audit trail + queue depths.
- `scripts/join-drill-channel.sh` — invite the drill runner to the freshest `incident-response-p1-*` channel via bot token.
- `scripts/ci-drill.sh` — CI-mode drill that fires, asserts audit events, archives the channel, cleans up.

#### Testing + CI

- 100% branch coverage enforced on `src/utils/audit.ts` and `src/services/statuspage-approval-gate.ts` via per-file thresholds in `vitest.config.ts`.
- Integration tests against `amazon/dynamodb-local` for `ConsistentRead` semantics, idempotency, and cross-incident isolation.
- Unit suite covers HttpClient retry + timeout, circuit breaker state machine, HMAC cache invalidation, Slack adapter fail modes, Zod command-text validation.
- GH Actions `ci.yml`: lint + format:check, build, unit + coverage, integration (dynamodb-local service container), `npm audit`, `tsc --noEmit` (incl. tests), invariant grep-gates (Statuspage gate, Slack adapter, HTTP client, baked secrets, secret-inventory drift), `helm template` staging + production, Docker build.
- GH Actions `drill.yml`: on-demand drill against a deployed environment via GH OIDC. Asserts `ROOM_ASSEMBLED` + required audit events. Fails with the exact list of what to configure when the OIDC role or the webhook hostname is missing.
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
- IAM least privilege — the IAM role is scoped to specific resource ARNs + GSI paths; the staging role cannot read production secrets and vice versa.

[Unreleased]: https://github.com/nanohype/incident-response/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nanohype/incident-response/releases/tag/v0.1.0
