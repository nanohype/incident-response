# incident-response — agent entry point

You're an AI client (or the author of one) about to run this service locally, add a `/incident-response` subcommand, wire a new SQS event type, or ship it as a Platform tenant. This file gets you running in five minutes. For the wider picture — how this repo fits into the nanohype stack — read the [Platform Reference](../nanohype/docs/platform-reference.md).

> Two identity tokens run through this repo: the app is `incident-response` (npm package, image, OTel `service.namespace` / `agents.platform`, the `/incident-response` slash commands + Slack app, the `incident-response/<env>/*` secret prefixes, and the landing-zone `incident-response-platform` substrate component), and the owning team is `reliability` (`Platform.spec.tenant`, OTel `agents.tenant`). See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full split.

## What this repo gives you

A ceremonial incident-commander assistant for P1s. A Grafana OnCall webhook fires, and within a five-minute SLO the bot stands up a Slack war room: a private channel, responders pulled in parallel from WorkOS Directory Sync + the Grafana OnCall escalation chain, a Grafana Cloud context snapshot attached, an incident checklist pinned, and a 15-minute status-update nudge scheduled. The IC drives it from Slack with `/incident-response` subcommands — `status`, `resolve`, `silence`, `checklist`, `help`.

The load-bearing property is that **every customer-facing Statuspage message goes through the `StatuspageApprovalGate`** — a two-phase commit that writes an approval record to the audit log, re-reads it with `ConsistentRead: true`, and only then calls `StatuspageClient.createIncident()`. There is no auto-publish path. A CI grep-gate fails the build on any new call site of `createIncident()` outside that one file, and its branch coverage is pinned at 100%.

It's built as a reusable subsystem. Every external-IO service is a constructor-injected client (port-based DI) — `src/wiring/dependencies.ts` is the single place real SDK clients are constructed, and everything downstream runs against the injected handle. Forking incident-response for a different client means swapping clients, table names, and the Slack workspace, not touching business logic.

## Run it in five minutes

```bash
npm install                # root deps; no workspace or file: links
cp .env.example .env       # fill in the required keys (see CLAUDE.md > Configuration)
npm run dev                # ts-node-dev against the processor entrypoint (SQS consumer + MCP server)
```

In Slack: `/incident-response help` lists the subcommands; `/incident-response status` posts the current incident state.

```bash
npm run check                      # typecheck + lint + format:check + test:unit (CI parity, one shot)
npm run test:integration:docker    # approval-gate semantics against amazon/dynamodb-local
```

This is a **CommonJS** app (no `"type": "module"`, `tsconfig` `module: commonjs`) and tests run on **Jest** — both deliberate, see [`ARCHITECTURE.md`](ARCHITECTURE.md) > Key decisions.

## Contract surface

Shipping this on a cluster means three artifacts travel together: the **Platform CR**, the **Helm chart**, and the **gitops entry**. They're the tenant contract.

### The Platform CR (`platform.yaml`)

Three CRs — a cluster-scoped `Tenant` (`platform.nanohype.dev/v1alpha1`) for the owning team, a `BudgetPolicy` (`governance.nanohype.dev/v1alpha1`), and the `Platform` (`platform.nanohype.dev/v1alpha1`) that references both:

```yaml
apiVersion: platform.nanohype.dev/v1alpha1
kind: Tenant
metadata:
  name: reliability
spec:
  displayName: Reliability
  primaryPersona: ops
  aggregateMonthlyBudgetUsd: "2500"
  compliance: { soc2: true, hipaa: false }
---
apiVersion: governance.nanohype.dev/v1alpha1
kind: BudgetPolicy
metadata:
  name: incident-response
  namespace: tenants-reliability
spec:
  platformRef: { name: incident-response }
  monthlyUsd: "2500" # kill-switch fires at 120% (USD 3000)
  alertThresholdsPercent: [50, 80, 100]
  killSwitchEnabled: true
---
apiVersion: platform.nanohype.dev/v1alpha1
kind: Platform
metadata:
  name: incident-response
  namespace: tenants-reliability
spec:
  displayName: incident-response
  persona: ops
  tenant: reliability
  budget: { name: incident-response }
  identity:
    allowedModelFamilies: [anthropic] # Claude via Bedrock
    extraPolicyArns: [] # app pods assume the landing-zone role directly
  compliance: { soc2: true }
  isolation: namespace
```

`tenants-reliability` is the team's control-plane namespace — it holds these CRs. The workload namespace is a different one: the operator derives `tenants-incident-response` from `Platform.metadata.name` and provisions it along with the ResourceQuota, LimitRange, default-deny NetworkPolicy, an ArgoCD AppProject named `incident-response`, and a per-Platform IAM role trusting the `tenant-runtime` SA. **incident-response's own app pods don't use that operator role** — both workloads assume the landing-zone `incident-response-platform` IAM role directly via the EKS Pod Identity association. `extraPolicyArns` stays empty for that reason; the operator's per-tenant role is for AgentFleet pods, not incident-response's app pods.

### The Helm chart (`chart/`)

Two workloads in one chart — the webhook ingress and the processor — plus everything that supports them. Templates under `chart/templates/`:

| Template                                                | Owns                                                                                                                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-deployment.yaml` + `webhook-service.yaml`      | The public-ingress webhook (`dist/bin/webhook-server.js`) — Grafana OnCall HMAC verifier + SQS FIFO enqueue, and the signed-HTTP Slack slash + interactivity endpoints, ClusterIP :3001, 2 replicas for rolling restarts |
| `webhook-ingress.yaml`                                  | ingress-nginx + cert-manager TLS, `POST /webhook` for Grafana OnCall + `/slack` prefix for the Slack Request URLs                                                     |
| `processor-deployment.yaml`                             | The single-writer singleton (`dist/index.js`) — SQS consumer + war-room assembler + in-process MCP server (`http` + `mcp` container ports). `Recreate` strategy + 60s `terminationGracePeriodSeconds` for in-flight SQS drain |
| `mcp-service.yaml`                                      | ClusterIP in front of the processor's MCP port — the mcp-tunnel target; NetworkPolicy locks the port to the `mcp-tunnel` namespace                                    |
| `serviceaccount.yaml`                                   | Shared SA across both workloads, name pinned to the app; bound to the landing-zone IAM role by a Pod Identity association                                                                      |
| `externalsecret.yaml`                                   | ESO syncs `incident-response/<env>/grafana-oncall-hmac` + `app-secrets` + `grafana-cloud` into one Secret consumed via `envFrom`; HMAC secret id also passed as env for the VersionId-keyed cache refresh |
| `networkpolicy.yaml`                                    | Default-deny + ingress (ingress-nginx → webhook only) + egress (DNS + HTTPS)                                                                                           |
| `prometheusrule.yaml`                                   | SLO + reliability alerts                                                                                                                                               |
| `grafana-dashboard.yaml`                                | ConfigMap labeled `grafana_dashboard: "1"` loading `chart/dashboards/incident-response.json`                                                                                     |

`values.yaml` is the base; `values-staging.yaml` / `values-production.yaml` carry the per-env deltas (image tag, `tenantInfra.*` from the landing-zone outputs, ingress host). The image is `ghcr.io/nanohype/incident-response`. OTel attrs `service.namespace=incident-response`, `agents.tenant=reliability`, and `agents.platform=incident-response` are set in every values file (required by the platform-tenant contract — see the identity split in [`ARCHITECTURE.md`](ARCHITECTURE.md)).

### Required tenant files

A valid tenant in this repo is exactly these three, plus the chart's per-env values:

- `platform.yaml` — the `BudgetPolicy` + `Platform` CRs
- `chart/` — the chart above, with `values.yaml` + `values-staging.yaml` + `values-production.yaml`
- `gitops/applicationset-entry.yaml` — the ApplicationSet entry registered into `nanohype/eks-gitops` (matrix generator over clusters × the app, Helm multi-source `$values` resolving `values.yaml` + `values-<env>.yaml`, sync wave 100)

## Add a `/incident-response` subcommand

Slash commands live in `src/commands/` (one file per subcommand) behind the `CommandRegistry` (`src/services/command-registry.ts`). The registry is case-insensitive and replies "Unknown command" for anything unregistered, so dispatch never grows a `switch` in `src/index.ts`. To add one:

1. **Write the handler** — add `src/commands/<name>.ts` exporting a `make<Name>Handler(deps)` factory that returns a `CommandHandler` (`(ctx: CommandContext) => Promise<void>`). The `ctx` carries the resolved `incidentId` (looked up from the channel via the `slack-channel-index` GSI before dispatch), the `args`, the injected `slack` WebClient, and a `respond` callback. Pull every external dependency off the `deps` you accept — never reach for a module-level SDK client.
2. **Register it** — add one `.register('<name>', make<Name>Handler({ ... }))` line to `buildCommandRegistry` in `src/wiring/commands.ts`, wiring the handler's deps from the `Dependencies` bag. That's the only edit outside your new file.
3. **Drive the action through, or say so.** Silent stubs are bugs — if the handler can't complete (Linear down, Bedrock failed), the IC reply must be explicit about what worked and what didn't. Never reply "triggered" for work that didn't happen.
4. **Awaited audit writes.** Any state change writes an audit event through `AuditWriter`, and the write is `await`ed (`@typescript-eslint/no-floating-promises: error` enforces it). A fire-and-forget audit write is a security bug.
5. **Test it** — add a handler-level unit test under `test/unit/` plus an entry in the command-registry test. Inject fake clients via the deps; use `aws-sdk-client-mock` at the client level for AWS calls.

## Add an SQS event type

The processor drains two FIFO queues; each message dispatches through an `EventRegistry` (`src/services/event-registry.ts`) keyed on the message `type`. Unknown types log a warn and no-op. Event handlers live in `src/events/` (one file per type). To add one:

1. **Write the handler** — add `src/events/<type>.ts` exporting a `make<Name>Handler(deps)` factory returning `EventHandler<T>` (`(message: T) => Promise<void>`). Take the clients/services it needs as deps.
2. **Widen the message union** — add the new `type` to the relevant queue-message union (`IncidentQueueMessage` or `NudgeQueueMessage` in `src/services/sqs-consumer.ts`) so the dispatcher is type-checked against it.
3. **Register it** — add one `.on('<TYPE>', make<Name>Handler(...))` line to the matching `buildIncidentEventRegistry` / `buildNudgeEventRegistry` in `src/wiring/events.ts`.
4. **Mind the DLQ contract.** The SQS consumer does not `DeleteMessage` on a handler exception — visibility timeout (300s) drives retry, then the DLQ. Throw on a real failure; don't swallow it into a silent success.
5. **Test it** — add a handler-level unit test plus an entry in the event-registry test (registered-type assertion + dispatch behavior).

## Conventions

- **Port-based DI.** Every external service is reached through a constructor-injected client, never a module import. `src/wiring/dependencies.ts` builds the concrete clients once; handlers and services receive them as deps. Forking for a new client swaps the client instance, not the business logic.
- **Awaited audit writes.** `AuditWriter.write` and the approval writes are always `await`ed — `no-floating-promises` is an error, not a warning. Audit durability is a security property.
- **Registry dispatch.** New subcommand = one file in `src/commands/` + one `.register()` line. New SQS event = one file in `src/events/` + one `.on()` line. Never grow a `switch` in `src/index.ts`.
- **The `StatuspageApprovalGate` invariant.** The two-phase commit (write `STATUSPAGE_DRAFT_APPROVED` → re-read `ConsistentRead: true` → `createIncident()`) is the only path that publishes to Statuspage. No auto-publish, no escape hatch, no silent mode. The grep-gate and the 100%-branch coverage on `src/services/statuspage-approval-gate.ts` + `src/utils/audit.ts` stay live in CI.
- **Slack calls have explicit deadlines.** WebClient-level `timeout` plus per-call `withTimeout` / `withTimeoutOrDefault` on non-critical paths. Assembly must finish in the ≤5-min SLO and can't be hostage to one wedged call. Metrics are best-effort — `MetricsEmitter` swallows errors and never throws up to the caller.
- TypeScript strict (`exactOptionalPropertyTypes`), CommonJS, Node ≥ 24. Zod at every boundary (config, webhook payloads). Pino JSON to stderr with OTel `trace_id`/`span_id` correlation. Explicit timeouts on every external call (`HttpClient` 5s/2-retry; `withTimeout(8000)` around the deadline-less `@linear/sdk`). ESLint flat config + typescript-eslint, Prettier.

## Pointers

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — bounded contexts, the webhook→SQS→processor data flow, load-bearing decisions, the app/team identity split, and where the boundaries sit (landing-zone substrate, eks-gitops addons)
- [`CLAUDE.md`](CLAUDE.md) — per-module breakdown, configuration, full conventions, test map
- [`README.md`](README.md) — front door: run, test, deploy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the subcommand / SQS-event recipes + the test contract + PR flow
- [`chart/README.md`](chart/README.md) — template-by-template chart reference + the per-tenant infra it expects
- [`docs/`](docs/) — deployment guide, secrets, troubleshooting, drills, fork-for-a-new-client
- [Platform Reference](../nanohype/docs/platform-reference.md) — the stack-wide view
- [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) — the operator that reconciles the Platform CR
- [`landing-zone`](https://github.com/nanohype/landing-zone) — the `incident-response-platform` substrate the chart's IAM role and data stores live in
