# Architecture

`incident-response` (internal service handle: **incident-response**) is a ceremonial incident-commander assistant: a Grafana OnCall webhook fires, and within a five-minute SLO it stands up a Slack war room, drives the incident from `/incident-response` subcommands, gates every customer-facing Statuspage publish behind an explicit approval, and drafts a postmortem on resolve. This document covers the bounded contexts, the load-bearing decisions, the data flow from alert to assembled war room, the identity-rename split, and where the boundaries sit relative to the rest of the stack.

## The identity split (read this first)

The repo and its GitHub-coupled handles are `incident-response`. Everything the running system *emits or invokes* stays `incident-response`. This is intentional, not drift:

| Surface | Value | Why |
| --- | --- | --- |
| GitHub repo, product name, npm package, image repo, gitops `repoURL`/`path` | `incident-response` | GitHub-coupled identity — flips with the repo |
| OTel `service.namespace` + `agents.platform` | `incident-response` | Telemetry identity. Grafana dashboards, PrometheusRule PromQL, and historical metrics/traces key on it — renaming orphans them |
| `agents.tenant` + namespace + AppProject | `protohype` / `tenants-protohype` / `tenant-protohype` | The protohype *team* boundary, not the repo. The landing-zone Pod Identity association targets it |
| `/incident-response` slash commands + the Slack app | `incident-response` | The user-facing product surface in Slack — renaming changes how operators invoke the bot |
| Secret prefixes (`incident-response/<env>/*`), DDB/SQS/Scheduler resource names, `incident-response.json` dashboard | `incident-response` | Owned by the landing-zone `incident-response-platform` substrate outputs — renaming them is a substrate change, out of scope here |

Net: the repo is `incident-response`; the running telemetry identity, the Slack product surface, and all substrate-owned names stay `incident-response`. A grep that finds `incident-response` emitted at runtime is finding documented intent, not leftover rename residue.

## Bounded contexts

The domain types organize around seven bounded-context modules under `src/types/`, re-exported through `src/types/index.ts` as a barrel. Each module is the home for one kind of contract; downstream code imports from the barrel and never reaches into a module directly.

| Context        | Module path             | What it owns                                                                                                                                                       |
| -------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **incident**   | `src/types/incident.ts` | `IncidentRecord`, `IncidentStatus`, `IncidentSeverity` (P1/P2/P3), `ICPulseRating` (1–5) — the incident state machine and the IC's post-resolution pulse rating    |
| **grafana**    | `src/types/grafana.ts`  | `GrafanaOnCallPayloadSchema` (the Zod schema the webhook validates against) + the inferred alert payload, the OnCall user/escalation-chain shapes, and `GrafanaContextSnapshot` (the Grafana Cloud context attached to the war room) |
| **audit**      | `src/types/audit.ts`    | `AuditEventType`, the per-type `AuditDetailsByType` map, and the `AuditEvent` record — the append-only audit ledger's vocabulary                                    |
| **statuspage** | `src/types/statuspage.ts` | `StatusPageDraft` — the draft lifecycle shape (`PENDING_APPROVAL` → `PUBLISHED` / `REJECTED`) the approval gate operates on                                        |
| **postmortem** | `src/types/postmortem.ts` | `PostmortemDraft` — the Bedrock-generated postmortem sections the resolve flow files into Linear                                                                   |
| **directory**  | `src/types/directory.ts`  | `DirectoryUser` — the IdP-neutral responder identity, so swapping WorkOS for another directory is a client-file change, not type surgery                          |
| **errors**     | `src/types/errors.ts`     | The domain error classes — `AutoPublishNotPermittedError`, `DirectoryLookupFailedError`, `ExternalClientTimeoutError`                                              |

The runtime is organized as a thin wiring layer over a set of services and per-service clients. `src/index.ts` (< 80 LOC) validates env, builds the dependency bag via `src/wiring/dependencies.ts`, registers the command + event registries (`src/wiring/commands.ts` / `events.ts`), starts the Slack app + SQS consumer + health server, and installs the SIGTERM handler. The services live in `src/services/` (the war-room assembler, the approval gate, the nudge scheduler, the SQS consumer, the two registries); the per-service adapters in `src/clients/` (Statuspage, Linear, GitHub, WorkOS, Grafana OnCall, Grafana Cloud); the Bedrock wrapper in `src/ai/incident-response-ai.ts`; cross-cutting utilities (`audit.ts`, `http-client.ts`, `metrics.ts`, `with-timeout.ts`, `logger.ts`, `incident-lookup.ts`) in `src/utils/`.

## Key decisions

### Port-based DI

Every module that touches an external boundary takes its clients as constructor-injected ports — not module imports. `src/wiring/dependencies.ts` is the one place the concrete SDK clients (DynamoDB, SQS, Scheduler, Bedrock, CloudWatch, Slack `WebClient`, and the per-service adapters) are built; the registries and services receive them in their factory deps. Tests inject fakes implementing the port and use `aws-sdk-client-mock` at the client level for AWS calls — no module-level SDK mocks. The payoff is that forking incident-response for a different client (different Slack workspace, Linear project, DynamoDB tables, Grafana tenant) is a swap of client instances and config, not a refactor that ripples through business logic.

### The `StatuspageApprovalGate` two-phase commit

This is the property the whole product hangs on. Customer-facing Statuspage messages **never** publish without an explicit, durable, re-verified approval. `src/services/statuspage-approval-gate.ts` is the **only** code path that may call `StatuspageClient.createIncident()`, and `approveAndPublish` runs the publish as a two-phase commit:

1. **Write** — after loading and validating the `PENDING_APPROVAL` draft, write the approval record to the audit log via `AuditWriter.writeStatuspageApproval` — `await`ed.
2. **Verify** — re-read the audit log with `verifyApprovalBeforePublish`, which queries with `ConsistentRead: true` so the just-written approval record *must* be visible before anything publishes — `await`ed.
3. **Publish** — only then call `createIncident()`, then write `STATUSPAGE_PUBLISHED` and flip the draft to `PUBLISHED`.

If the write or the consistent-read verify fails, the Statuspage call never happens and the gate throws `AutoPublishNotPermittedError`. There is no auto-publish, no escape hatch, no silent mode. Two CI guardrails keep this honest: a grep-gate fails the build on any new call site of `createIncident()` outside the gate file, and the branch coverage on `statuspage-approval-gate.ts` + `utils/audit.ts` is pinned at 100% (flipping `ConsistentRead: true` → `false` in `audit.ts` turns the suite red — the regression proof in the README).

### Socket-mode singleton processor

The processor is a Slack socket-mode connection, and socket mode is a singleton — two sockets briefly running would each receive and dispatch the same Slack event, doubling actions. So `processor-deployment.yaml` runs `replicaCount: 1` with `strategy: Recreate` (not `RollingUpdate`): a deploy takes the old pod down before the new one comes up, accepting brief downtime over a double-dispatch window. `terminationGracePeriodSeconds: 60` gives the in-flight SQS messages time to drain on shutdown. The webhook Deployment is the opposite — stateless HTTP, 2 replicas, rolling restarts — because it only verifies HMAC and enqueues. The SQS consumer is DLQ-safe: it does not `DeleteMessage` on a handler exception, so the 300s visibility timeout drives retry and then the DLQ.

### CommonJS — deliberate, not a mislabel

This app is CommonJS by design: `package.json` carries no `"type": "module"` and `tsconfig.json` emits `module: commonjs`. The org convention is ESM; this repo deliberately diverges. The runtime is Node 24 and every dependency is CJS-compatible, so the choice costs nothing at runtime — and it removes the "looks like ESM but isn't" ambiguity, which is the real footgun around the 100%-branch-coverage invariant files (`audit.ts`, `statuspage-approval-gate.ts`). The same reasoning puts the test runner on **Jest** (`jest.config.cjs` + `jest.config.integration.cjs`) rather than Vitest — the standard requires `npm test` to pass, it does, and the 100%-branch enforcement stays intact. Test files are type-checked separately (they're excluded from the build `tsc`), so test type drift still surfaces.

### Bedrock prompt caching via Anthropic `cache_control`

`src/ai/incident-response-ai.ts` calls Bedrock with `InvokeModelCommand` (the raw Anthropic Messages body) and marks the stable system prompt with `cache_control: { type: 'ephemeral' }`. On `InvokeModel` that *is* the correct caching mechanism — `cachePoint` is a Converse-API marker and does not apply here. `stripPII` runs before every Bedrock call, and both `generateStatusDraft` and `generatePostmortemSections` fall back to safe templates if Bedrock fails.

## Data flow: alert to assembled war room

```
1.  Grafana OnCall fires a webhook            → webhook Deployment (src/handlers/webhook-ingress.ts via src/bin/webhook-server.ts)
2.  verify HMAC-SHA256 (crypto.timingSafeEqual; secret cached on SecretsManager VersionId, 5-min TTL, force-refresh on failure)
                                              → bad signature? 401, stop
3.  validate payload (GrafanaOnCallPayloadSchema, Zod) → invalid? 4xx, stop
4.  idempotent write to DynamoDB (ConditionExpression) + enqueue to SQS FIFO
5.  processor (SQS consumer) receives          → EventRegistry dispatch on message.type
6.  ALERT_RECEIVED → WarRoomAssembler:
      • create private Slack channel (critical path, longest deadline)
      • resolve responders in parallel (Promise.allSettled): WorkOS Directory Sync + Grafana OnCall escalation chain
      • attach Grafana Cloud context snapshot (non-critical, withTimeoutOrDefault)
      • pin the incident checklist
      • schedule a 15-min status-update nudge via EventBridge Scheduler
7.  IC drives from Slack: /incident-response status | resolve | silence | checklist | help (CommandRegistry dispatch)
8.  customer-facing Statuspage publish → StatuspageApprovalGate (write → ConsistentRead verify → createIncident)
9.  /incident-response resolve → Bedrock postmortem draft → Linear issue → delete nudge → pulse rating → status RESOLVED + audit
```

Directory resolution failing is an explicit IC error plus a `DIRECTORY_LOOKUP_FAILED` audit event and zero fabricated invites — never a half-assembled room presented as complete. Honest-failure paths run throughout: on `/incident-response resolve`, if Linear is down the incident still flips to RESOLVED but the IC reply states exactly what worked and what didn't. Slack I/O is funnelled through `SlackAdapter` so the timeout/fail-mode discipline can't be bypassed — domain code never holds a raw `WebClient`. The nudge scheduler *disables* (not deletes) a schedule when the IC silences it, preserving the audit trail.

## What this repo deliberately does NOT do

- **Not its own cloud substrate.** It does not provision DynamoDB, SQS, EventBridge Scheduler, S3, KMS, or the IAM role. Those are landing-zone (see Boundaries). The chart consumes their outputs.
- **Not a model host.** Bedrock runs Claude inference outside the cluster on-account. No self-hosted models, no AI framework (no LangChain) — direct Bedrock SDK via `IncidentResponseAI`.
- **Not a cluster bootstrap.** The EKS cluster, ArgoCD, and the cluster addons it depends on (ESO, ingress-nginx, cert-manager, the observability stack) must already exist (eks-gitops).
- **Not the tenant operator.** It declares a `Platform` CR; the `eks-agent-platform` operator reconciles the namespace, IRSA, and AppProject.
- **Not the owner of Bedrock invocation logging.** Bedrock invocation logging is set to NONE so IC↔AI conversations never reach CloudWatch — but that is an **account-level control owned by landing-zone**, not enforced by app code. The app relies on it being in place.

## Boundaries

This repo owns the application — source, chart, Platform CR, gitops entry. Everything underneath it lives in two other repos.

### Substrate → `landing-zone`

`landing-zone/components/aws/incident-response-platform/` provisions the per-tenant AWS data plane and does not move here:

- DynamoDB tables — incidents, audit log, identity cache (`dynamodb.tf`)
- SQS FIFO queues + DLQs — incident events, nudge events, SLA-check (`sqs.tf`)
- EventBridge Scheduler group for the per-incident status-update nudges (`scheduler.tf`)
- S3 audit/artifacts bucket (`s3.tf`)
- The `incident_response_irsa` role (`irsa.tf`)
- Secrets Manager seeding (`incident-response/<env>/grafana-oncall-hmac`, `app-secrets`, `grafana-cloud`)
- Account-level Bedrock invocation logging = NONE

Its IAM role is the role incident-response's app pods assume, bound to the chart's ServiceAccount by an EKS Pod Identity association. The table names, queue URLs/ARNs, scheduler role/group, and the secret ids land in the chart's `tenantInfra.*` (filled from `tofu output` at deploy time; the committed defaults stay empty so no account id / region / ARN is hardcoded). The chart contains **no inline IAM**; the role and the association are owned in landing-zone and consumed by reference. Both workloads share one SA, both assume the `incident-response-platform` role. The substrate directory name and the `incident-response/<env>/*` secret prefixes stay `incident-response` — they're the substrate's own identity.

### Cluster addons → `eks-gitops`

The chart assumes these cluster-level capabilities are already installed and reconciled by `eks-gitops`:

- **External Secrets Operator** — backs `externalsecret.yaml` (syncs the three `incident-response/<env>/*` Secrets Manager entries into one Secret; the HMAC secret id is also passed as env for the webhook handler's VersionId-keyed cache refresh)
- **ingress-nginx** + **cert-manager** — back `webhook-ingress.yaml` (TLS for `POST /webhook`)
- **observability stack** — the cluster OTel Collector (`grafana-agent.monitoring.svc.cluster.local:4318`) and log forwarder that carry traces/metrics/logs to Grafana Cloud. The app emits OTLP and structured Pino JSON to stderr; there are no per-pod sidecars. The `prometheusrule.yaml` alerts and the `grafana-dashboard.yaml` dashboard (`chart/dashboards/incident-response.json`) load into that stack, querying the `incident-response`-namespaced telemetry.
