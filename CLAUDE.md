# incident-response

Ceremonial incident commander assistant — P1 war-room assembly, approval-gated Statuspage publish, postmortem draft.

> Two identity tokens: the app is `incident-response` (npm package, image, OTel `service.namespace` / `agents.platform`, the `/incident-response` slash commands + Slack app, the `incident-response/<env>/*` secret prefixes, the landing-zone `incident-response-platform` substrate component), and the owning team is `reliability` (`Platform.spec.tenant`, OTel `agents.tenant`). Full split in `ARCHITECTURE.md`.

## What This Is

Composes nanohype templates (`ts-service` worker-service variant, `agentic-loop`, `prompt-library`, `module-llm`) into two Kubernetes Deployments. A stateless **webhook** Deployment behind ingress-nginx serves three signature-verified HTTP surfaces: Grafana OnCall webhooks (HMAC) and the Slack slash-command + Block Kit interactivity Request URLs (Slack signing secret). A singleton **processor** Deployment runs the SQS consumer + war-room assembler + nudge scheduler and hosts the streamable-HTTP **MCP server** — the read + draft pull surface a Claude surface (Claude Tag et al.) reaches over the mcp-tunnel. There is no Slack socket mode and no Bolt; Slack interactions arrive as signed HTTP.

Fork me for a different client by swapping secrets, DynamoDB table names, Slack workspace, Linear project, and Grafana tenant. Port-based DI is load-bearing — every external call goes through a constructor-injected client, not a module import. End-to-end walkthrough in `docs/forking-for-a-new-client.md`.

## How It Works

Grafana OnCall fires a webhook → the webhook Deployment (behind ingress-nginx) verifies HMAC-SHA256, validates Zod schema, idempotently writes to DynamoDB, enqueues to SQS FIFO → the processor Deployment picks up the event, dispatches via `EventRegistry` to `WarRoomAssembler` → Slack private channel created, responders invited via parallel WorkOS Directory Sync + Grafana OnCall queries, Grafana Cloud context snapshot attached, checklist pinned, 15-min nudge scheduled via EventBridge Scheduler.

When the IC runs `/incident-response resolve`, the `CommandRegistry` dispatches to the resolve handler: generates a postmortem draft via Bedrock (`claude-sonnet-4-6`), creates a Linear issue via `@linear/sdk`, deletes the nudge schedule, posts a 1–5 star pulse rating to the channel, flips the incident status to RESOLVED, and writes `INCIDENT_RESOLVED` + `POSTMORTEM_CREATED` audit events.

Customer-facing Statuspage messages ALWAYS go through the `StatuspageApprovalGate`. The gate writes `STATUSPAGE_DRAFT_APPROVED` to the audit log, then queries the same log with `ConsistentRead: true`, and only then calls `StatuspageClient.createIncident()`. If the audit write or the verify fails, the Statuspage call never happens and the gate throws `AutoPublishNotPermittedError`. CI grep-gate prevents any new call site of `createIncident()` outside the gate file.

## Architecture

- **src/index.ts** — the processor entrypoint (thin wiring). Env validation, dependency construction via `src/wiring/`, event registries, SQS consumer startup, the streamable-HTTP MCP server (on `MCP_PORT`), health server, SIGTERM drain. No Slack app — the slash + interactivity surface lives on the webhook Deployment.
- **src/handlers/slack-signature.ts** — Slack request signature verification (v0 scheme: `X-Slack-Signature` = HMAC-SHA256 over `v0:{timestamp}:{rawBody}`, `crypto.timingSafeEqual`, 5-min replay window). The trust boundary for every human safety gesture, including the compliance-gated approve/publish.
- **src/handlers/slack-interactions.ts** — the signed-HTTP Slack surface: slash-command dispatch (same `CommandRegistry` + channel→incident resolution + Zod validation as before, deferred reply via `response_url`) and Block Kit interactivity (approve / edit / silence / pulse). `statuspage_approve` calls `approvalGate.approveAndPublish(incident_id, draft_id, body.user.id)` — the clicking human is the approver. Not an MCP tool.
- **src/mcp/** — the read + draft MCP pull surface. `server.ts` is a streamable-HTTP MCP server (official `@modelcontextprotocol/sdk`) on `MCP_PORT` (default 3002); `tools.ts` is the tool set: `get_incident`, `list_open` (read), `draft_statuspage_update` (→ `approvalGate.createDraft`, PENDING_APPROVAL, publishes nothing), `draft_postmortem` (the Bedrock postmortem draft text). READ + DRAFT ONLY — approve/publish/resolve are NOT exposed; they stay human on the Slack surface. Every tool input is Zod-validated; a bad argument comes back as an `isError` result, an unknown tool as a protocol error. The mcp-tunnel is the only ingress (chart NetworkPolicy).
- **src/wiring/** — `dependencies.ts` constructs all clients/services in one place; `commands.ts` / `events.ts` register handlers. Keeps `index.ts` from becoming a god module.
- **src/handlers/webhook-ingress.ts** — handler for Grafana OnCall webhooks, served by the webhook Deployment. HMAC verification with `crypto.timingSafeEqual`. Secret cache keyed on SecretsManager `VersionId`, 5-min TTL, force-refresh on verification failure (rotation race recovery).
- Bedrock invocation logging is set to NONE at the account level so IC↔AI conversations never reach CloudWatch. That's an account-level landing-zone control, not app code — there is no in-app handler for it.
- **src/services/command-registry.ts** — typed slash-command dispatcher. Register handlers via `.register(name, handler)`. Case-insensitive. Unknown subcommand returns "Unknown command" reply.
- **src/services/event-registry.ts** — typed SQS event dispatcher. Unknown event types log a warn and no-op.
- **src/services/war-room-assembler.ts** — assembles the war room (channel → responders → context → checklist → nudge). Parallel responder resolution via `Promise.allSettled`. Non-critical Slack calls wrapped in `withTimeoutOrDefault`.
- **src/services/statuspage-approval-gate.ts** — THE critical module. ONLY code path that calls `StatuspageClient.createIncident()`. Two-phase commit. 100% branch coverage enforced by CI.
- **src/services/nudge-scheduler.ts** — EventBridge Scheduler wrapper. Per-incident schedules. IC silence disables (not deletes) the schedule so audit trail is preserved.
- **src/services/sqs-consumer.ts** — Long-polling SQS consumer. DLQ-safe — no `DeleteMessage` on handler exception. Visibility timeout (300s) drives retry.
- **src/commands/** — one file per `/incident-response` subcommand. Each exports a `make<Name>Handler(deps)` factory. `resolve.ts` is the full 9-step resolution (load → commits → Bedrock postmortem → Linear issue → delete nudge → pulse blocks → status flip + audit → public announce → archive channel). Honest-failure paths: if Linear fails, the incident still flips to RESOLVED but the IC reply is explicit about what worked and what didn't.
- **src/events/** — one file per SQS event type.
- **src/clients/** — per-service adapters. All use `HttpClient` (5s timeout, 2-retry cap, jittered backoff) except `linear-client` (uses `@linear/sdk` directly, with every SDK call wrapped in `withTimeout(8000ms)` since the SDK has no native deadline).
- **src/ai/incident-response-ai.ts** — Bedrock wrapper. Model IDs come from the zod-validated env config (`BEDROCK_SONNET_MODEL_ID` / `BEDROCK_HAIKU_MODEL_ID` in `src/config/`). System prompts have `cache_control: { type: 'ephemeral' }`. The vendored `redact` (`src/vendor/runtime/pii.ts`, full union category set with typed tokens) runs over every generated status draft before it reaches the IC. Safe fallback templates for both `generateStatusDraft` and `generatePostmortemSections` if Bedrock fails; the classifier zod-parses Haiku's JSON output and falls back to `{ is_status_update: false, confidence: 0 }` on malformed or wrong-shape output.
- **src/config/** — zod-validated env config for defaulted values (Bedrock model IDs). Required no-default env vars stay with `requireEnv` at startup.
- **src/utils/audit.ts** — All writes AWAITED. ConditionExpression for idempotency.
- **src/utils/errors.ts** — `stringifyError` — the one error-normalization helper every structured-log `error:` field goes through; both ternary arms covered explicitly in `test/unit/errors.test.ts`.
- **src/utils/http-client.ts** — Base HTTP client. Hard-capped timeout (≤5000ms) and retries (≤2). AbortController. Structured log on every retry + timeout.
- **src/utils/metrics.ts** — `MetricsEmitter` over the OTel Metrics API, on top of the vendored runtime metrics module (namespace-qualified `incident_response.*` series, per-name instrument caching, no-op without a provider). Fire-and-forget; the SDK buffers and batches, so emission never blocks a caller.
- **src/utils/with-timeout.ts** — `withTimeout` (throws on deadline; re-exported from the vendored resilience module) + the app-side `withTimeoutOrDefault` (swallows, returns fallback, warn-logs). Used around non-critical Slack calls.
- **src/utils/circuit-breaker.ts** — app-side instrumentation (warn log + `circuit_open_count` / `circuit_open_reject_count` metrics) over the vendored sliding-window breaker. Wired around WorkOS directory lookups in `src/wiring/dependencies.ts`.
- **src/vendor/runtime/** — vendored `@nanohype/runtime` modules (`circuit-breaker.ts`, `resilience.ts`, `pii.ts`, `workos-directory.ts`), byte-identical to `nanohype/library/runtime/src/*` — the same consumption model as the vendored `chart/charts/tenant-chart-base`. `scripts/sync-vendored.mjs` (itself vendored from `library/scripts/`, driven by `scripts/vendored.json`) re-copies every vendored surface — runtime modules, `biome.base.json`, the chart base — from a nanohype checkout (`NANOHYPE_DIR`, default `../nanohype`); CI's `--check` mode fails on drift. Behavior changes land upstream first, with their tests — never edit the copies. Vendored files are excluded from app lint/format/coverage (enforced upstream); `tsc` still typechecks and compiles them.
- **src/utils/env.ts** — `requireEnv(vars)` — fail-fast on missing required env vars.
- **src/utils/logger.ts** — Structured JSON logger to stdout/stderr. `.child({ incident_id })` threads correlation IDs.
- **src/types/** — bounded-context modules (`incident`, `grafana`, `audit`, `statuspage`, `postmortem`, `directory`, `errors`) re-exported through `types/index.ts` as a barrel. Custom error classes (`AutoPublishNotPermittedError`, `DirectoryLookupFailedError`, `ExternalClientTimeoutError`) live in `types/errors.ts`. Directory types (`DirectoryUser`) are IdP-neutral so swapping WorkOS for another provider is a client-file change, not a type surgery.
- **src/utils/incident-lookup.ts** — resolves war-room `channel_id` → canonical `incident_id` via the `slack-channel-index` GSI. Called from `src/index.ts` for every channel-scoped `/incident-response` subcommand before dispatch, so handlers receive the real incident ID and slash-command state queries go through a single index-backed lookup rather than a direct PK hit on a guessed ID.
- **chart/** — Helm chart for the k8s deployment. `Chart.yaml`, `values.yaml`, per-env deltas (`values-{staging,production}.yaml`), and templates under `chart/templates/`: `webhook-deployment.yaml` + `webhook-service.yaml` + `webhook-ingress.yaml` (the webhook Deployment running `src/bin/webhook-server.ts`, served publicly via ingress-nginx for the Grafana OnCall HMAC POSTs and the Slack signed-HTTP Request URLs on the `/slack` path prefix), `processor-deployment.yaml` (single-writer singleton — SQS consumer + assembler + in-process MCP server on the `mcp` container port; `Recreate` strategy, 60s `terminationGracePeriodSeconds` for in-flight SQS drain), `mcp-service.yaml` (ClusterIP in front of the processor's MCP port — the mcp-tunnel target), `serviceaccount.yaml` (shared SA named `incident-response`, bound to the operator-reconciled `<env>-incident-response-tenant` IAM role by an EKS Pod Identity association the landing-zone `incident-response-platform` component creates — no role-arn annotation), `networkpolicy.yaml` (ingress-nginx → webhook; mcp-tunnel namespace → the processor MCP port; egress: DNS + HTTPS + OTLP), `externalsecret.yaml` (pulls incident-response/<env>/grafana-oncall-hmac + app-secrets into one Secret consumed via envFrom; HMAC secret is also passed as `GRAFANA_ONCALL_HMAC_SECRET_ID` env for the handler's VersionId-keyed cache refresh; no OTLP credential is projected, since the export target is the unauthenticated in-cluster Alloy receiver), `prometheusrule.yaml` (three SLO + reliability rules), `grafana-dashboard.yaml` (a `GrafanaDashboard` CR the grafana-operator reconciles, sourced from `chart/dashboards/incident-response.json`). Observability is cluster-level via eks-gitops, all of it through Grafana Alloy in the `monitoring` namespace: Pino JSON on stderr → Alloy's pod tail → the in-cluster Loki; OTLP on `alloy.monitoring.svc.cluster.local:4318` → the in-cluster Tempo (traces) + SigV4 remote-write to Amazon Managed Prometheus (metrics). See `chart/README.md` for the full template-by-template description.
- **platform.yaml** — the cluster-scoped `Tenant` CR for the `reliability` team, plus the Platform CR (`platform.nanohype.dev/v1alpha1`) and its co-declared BudgetPolicy (`governance.nanohype.dev/v1alpha1`) declaring incident-response as a tenant of that team on the `eks-agent-platform` operator. The Platform + BudgetPolicy live in the team's control-plane namespace `tenants-reliability`; the operator provisions the workload namespace `tenants-incident-response` from the Platform name, along with ResourceQuota (4 CPU / 8Gi memory), LimitRange, default-deny NetworkPolicy, an ArgoCD AppProject named `incident-response`, and the per-Platform IAM role `<env>-incident-response-tenant` the chart's ServiceAccount is bound to. CI validates every document in this file against the CRD schemas vendored under `schemas/crd/` — see `scripts/validate-platform-manifests.mjs`. Those schemas are digest-verified against `schemas/crd/provenance.json` before use, and `scripts/sync-crd-schemas.mjs --check` compares them to `nanohype/eks-agent-platform` at the pinned commit and that pin to upstream's tip.
- **gitops/applicationset-entry.yaml** — ApplicationSet entry for `nanohype/eks-gitops` (`applicationsets/apps-tenants.yaml`). Matrix generator (clusters × `[incident-response]`), Helm multi-source `$values` pattern, sync wave 100.
- **src/bin/webhook-server.ts** — Thin `node:http` wrapper around `src/handlers/webhook-ingress.ts`. Reads the body, hands the handler a `{ headers, body }` envelope, and writes the `{ statusCode, body }` it answers with. No new runtime dependencies — `node:http` is built in. This is the entrypoint the webhook Deployment runs; it serves the Grafana POST path, the two Slack Request URLs, and `/health` for k8s probes.
- **test/unit/** — isolated tests: adapters, audit writer, approval gate, registries, HMAC cache, plus wiring tests for the vendored modules (breaker instrumentation, WorkOS cache/stale-fallback/error contract). Logic tests for vendored code live upstream in `nanohype/library/runtime/src/*.test.ts`. `audit.test.ts` and `statuspage-approval-gate.test.ts` at 100% branch.
- **test/integration/** — against `amazon/dynamodb-local`. Exercise `ConsistentRead` semantics, idempotency, cross-incident isolation.

## Commands

```bash
npm install                        # or npm ci against the committed lockfile
npm run lint
npm run format                     # Biome — write
npm run format:check               # Biome — verify
npm run typecheck                  # tsc --noEmit (runs as part of `check`)
npm run build                      # tsc → dist/
npm run test:unit                  # enforces 100% branch on audit + approval-gate
npm run test:integration           # requires dynamodb-local on :8000 (or use :docker below)
npm run test:integration:docker    # starts Docker container, runs tests, cleans up
npm run check                      # typecheck + lint + format:check + test:unit — CI parity
npm run dev                        # ts-node-dev against the processor entrypoint (SQS consumer + MCP server)
npm run sync:vendored               # re-copy vendored chart + runtime + config from ../nanohype (or $NANOHYPE_DIR)
npm run sync:vendored:check         # CI drift gate — exit 1 if any vendored copy differs from its source
npm run platform:validate           # validate platform.yaml against the vendored eks-agent-platform CRD schemas
npm run schemas:sync                # re-vendor schemas/crd/ from ../eks-agent-platform (or $EKS_AGENT_PLATFORM_DIR)
npm run schemas:check               # CI drift gate — digests, upstream at the pinned commit, and whether that pin is stale
npm run platform:selftest           # seed defects into platform.yaml + a vendored schema; fail unless each is rejected
npm run chart:lint                  # helm lint chart
npm run chart:template:staging      # render chart with staging values
npm run chart:template:production   # render chart with production values

# Operator helpers (per-env flavours: :staging / :production)
npm run seed:staging               # JSON-driven Secrets Manager seed
npm run drill:staging              # fire a synthetic HMAC-signed P1
npm run drill:join:staging -- --user U…    # invite yourself to the freshest war-room channel
npm run observe:staging            # snapshot latest incident's state + audit trail
```

## Configuration

See README's Configuration table and `docs/secrets.md`. Secrets live in AWS Secrets Manager with separate rotation cadences — the CI inventory-drift gate enforces agreement between `secrets.template.json` and `scripts/seed-secrets.sh`. The External Secrets Operator projects them into one k8s Secret consumed via `envFrom`. The HMAC cache refreshes on `VersionId` change, so rotating the Grafana OnCall webhook HMAC secret does not require a pod restart. Other secrets (Slack, Linear, Grafana, Statuspage, WorkOS) are projected by the ExternalSecret; after rotation, `kubectl rollout restart` the relevant Deployment so the running pods pick up the new value.

## Conventions

Baseline conventions: Node 24, CommonJS (see `ARCHITECTURE.md` > Key decisions), strict TS with `exactOptionalPropertyTypes`, Zod at boundaries, structured JSON logging, Biome for lint + format, Vitest for tests.

IncidentResponse-specific:

- **Audit writes are awaited.** Biome's `noFloatingPromises`, set to `error` in `biome.json`, enforces this. A fire-and-forget audit write is a security bug, not a style issue.
- **Slack calls have explicit deadlines.** WebClient-level `timeout: 10000` plus per-call `withTimeout` / `withTimeoutOrDefault` for non-critical paths. Assembly must complete in ≤5 min SLO and cannot be hostage to a single wedged call.
- **Silent stubs are bugs.** If a command doesn't drive its action through, it says so to the IC. Never reply "triggered" for work that didn't happen.
- **Metrics are best-effort.** `MetricsEmitter` swallows errors. Operational visibility degrades; incident handling doesn't.
- **Registry pattern for dispatch.** New slash command = one file in `src/commands/`, one `.register()` line in `src/wiring/commands.ts`. Never grow a `switch` in `index.ts`.
- **Port-based DI for subsystem reuse.** Every external service accessed through a constructor-injected client. Forking incident-response for a new client means swapping the client instance, not touching business logic.

## Testing

### Test matrix

| Tier | Files | What they exercise |
|------|-------|-------------------|
| Static | `tsconfig.json` strict + `biome.json` | Types, lint rules (no floating promises, no-explicit-any, no-console), consistent format |
| Unit | `test/unit/*.test.ts` | Pure functions, mocked SDKs, handler flows, adapter fail modes |
| Integration | `test/integration/*.integration.test.ts` | Real dynamodb-local — `ConsistentRead`, idempotency, cross-incident isolation |
| E2E (scripted) | `scripts/fire-drill.sh`, `scripts/ci-drill.sh` | Full webhook → SQS → processor → Slack → DDB path, in a live staging stack |
| E2E (manual) | `artifacts/incident-drill-playbook.md` | Tabletop + live-fire drills against real Grafana OnCall routing |

### Coverage

- 100% branch on `src/utils/audit.ts` and `src/services/statuspage-approval-gate.ts`. CI fails on regression.
- Global 55% branches / 75% statements / 75% lines / 75% functions. These are honest thresholds — if a future PR lowers coverage, CI goes red.
- Regression experiment proves enforcement is live: flipping `ConsistentRead: true` → `false` in `audit.ts` makes `npm run test:unit` exit 1. See README for the procedure.

### Adding tests

- Security-critical changes go in the 100%-threshold files. Every new branch needs both sides covered.
- Dispatch-layer changes (new command, new event) get a handler-level unit test plus an entry in the relevant registry test.
- Anything that depends on DynamoDB semantics (consistency, conditions, GSI) → integration test, not unit.

## Dependencies

| Package | Why |
|---------|-----|
| `@slack/web-api` | Outbound Slack: war-room assembly, channel/user operations, posting approval messages + buttons |
| `@modelcontextprotocol/sdk` | The streamable-HTTP MCP server — the read + draft pull surface for Claude surfaces over the mcp-tunnel |
| `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb` | Incident + audit state |
| `@aws-sdk/client-sqs` | Incident event queue (FIFO) |
| `@aws-sdk/client-secrets-manager` | HMAC secret fetch for the webhook handler (VersionId-keyed cache refresh) |
| `@aws-sdk/client-scheduler` | EventBridge Scheduler for 15-min nudges |
| `@aws-sdk/client-bedrock-runtime` | `claude-sonnet-4-6` + `claude-haiku-4-5` inference via `InvokeModel` |
| `@linear/sdk` | Postmortem issue creation in Linear |
| `zod` | Boundary validation — webhook payloads, env config defaults, LLM classifier output |
| `aws-sdk-client-mock`, `aws-sdk-client-mock-vitest` | Mocking AWS calls + custom matchers in unit tests |

No heavy AI frameworks (no LangChain) — direct Bedrock SDK calls via `IncidentResponseAI`.
