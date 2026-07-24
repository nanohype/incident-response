# incident-response chart

Helm chart for the incident-response incident-commander assistant. Renders two workloads + supporting observability resources into a Platform tenant on the `eks-agent-platform` operator:

- **webhook** — `Deployment` + `Service` + `Ingress` (public, `alb` class; TLS terminates on the ALB against the ACM certificate `ingress.tls.certificateArn` names, or — left empty — one the AWS Load Balancer Controller matches to `ingress.host` in ACM). Serves three signature-verified HTTP surfaces: Grafana OnCall HMAC-signed P1 events (verify → idempotent DynamoDB write → SQS enqueue), and the Slack slash-command + Block Kit interactivity Request URLs on the `/slack` path prefix (Slack signing-secret verified; `statuspage_approve` runs the 2-phase gate inline with the clicking human's id).
- **processor** — `Deployment` (`Recreate` strategy — single-writer singleton). SQS consumer + war-room assembler + Statuspage approval-gate `createDraft` + Linear postmortem creator + EventBridge Scheduler nudge wrangler, and the in-process streamable-HTTP **MCP server** (the read + draft pull surface) on the `mcp` container port.
- **mcp** — `Service` (ClusterIP) in front of the processor's MCP port. The mcp-tunnel (outbound-only cloudflared) is the only thing allowed to reach it; the NetworkPolicy locks the port to the `mcp-tunnel` namespace. No public ingress.

Plus:

- **PrometheusRule** — three rules under `incident-response.slo`: assembly P99 SLO breach, directory-lookup failure spike, Statuspage publish failures. Off by default (`prometheusRule.enabled: false`): the CR only does something where a Prometheus Operator ruler watches for it, and the eks-gitops observability catalog runs the OpenTelemetry Collector remote-writing to Amazon Managed Prometheus with no in-cluster ruler. Turn it on — and set `prometheusRule.selector` to whatever that ruler's `ruleSelector` matches — on a cluster that runs one.
- **GrafanaDashboard CR** — sourced from `chart/dashboards/incident-response.json`. A `GrafanaDashboard` CR (instanceSelector `dashboards: external`) the grafana-operator reconciles onto the external Amazon Managed Grafana.

## Files

- `Chart.yaml`, `values.yaml`, `values-{staging,production}.yaml`
- `dashboards/incident-response.json` — Grafana dashboard JSON, inlined into the `GrafanaDashboard` CR at render time
- `templates/`
  - `_helpers.tpl` — name/label helpers + shared `incident-response.env` partial
  - `webhook-deployment.yaml`, `webhook-service.yaml`, `webhook-ingress.yaml` — the ingress routes both the Grafana webhook path and the `/slack` prefix to the webhook Service
  - `processor-deployment.yaml` — exposes the `http` (health) and `mcp` (MCP server) container ports
  - `mcp-service.yaml` — ClusterIP in front of the processor's MCP port (the mcp-tunnel target)
  - `serviceaccount.yaml` — single SA shared across both workloads
  - `networkpolicy.yaml` — ingress: the VPC range the ALB's interfaces sit in → webhook, mcp-tunnel namespace → processor MCP port; egress: DNS + HTTPS + OTLP
  - `externalsecret.yaml` — one remoteRef per integration, at `externalSecret.secretPrefix` plus the suffix in `externalSecret.keys`, composed into one Secret consumed by envFrom. Those are the paths `scripts/seed-secrets.sh` writes; CI renders the chart and fails on any path the seeder does not create. The HMAC secret is not projected — the webhook reads it through the pod's own grant, keyed on VersionId, so it rotates without a restart; the chart passes only its id. No OTLP credential either — the default export target is the unauthenticated in-cluster collector gateway receiver
  - `prometheusrule.yaml` — three alert rules (assembly SLO / directory failures / Statuspage publish failures)
  - `grafana-dashboard.yaml` — GrafanaDashboard CR with the dashboard JSON

## Webhook server entrypoint

`src/handlers/webhook-ingress.ts` exports the ingress handler as a pure function of a request envelope, so it holds no reference to a server. `src/bin/webhook-server.ts` is a thin `node:http` wrapper that reads the body, hands the handler the envelope, and writes the result back; the wrapper owns the transport and adds no runtime dependencies. The chart's webhook Deployment runs `node dist/bin/webhook-server.js`.

## Per-tenant infra (from landing-zone)

Single-tenant component `components/aws/tenant-substrate/` provisions everything incident-response's pods need:

- DynamoDB ×3 — incidents (slack-channel-index + by-timestamp GSIs), audit, identity-cache
- SQS FIFO ×6 — incident-events / nudge-events / sla-check (+ DLQs)
- EventBridge Scheduler group + ScheduleRole IAM role
- S3 audit-archive bucket
- IAM role with the consolidated inline policy (DDB rw, SQS rw, Bedrock invoke for Claude Sonnet 4.6 + Haiku 4.5, EventBridge Scheduler crud, Secrets Manager read)

Bedrock invocation-logging-NONE is a Bedrock account+region scoped policy, so it belongs to landing-zone's `cluster-bootstrap` component rather than to any single tenant; the reasoning is in `eks-agent-platform/ARCHITECTURE.md`.

Every Secrets Manager entry under `incident-response/<env>/` is seeded by this repo's own `scripts/seed-secrets.sh`, from the inventory in `secrets.template.json`. The ExternalSecret projects the twelve integration credentials. Two are read through the AWS SDK instead: `grafana/oncall-webhook-hmac` by `src/handlers/webhook-ingress.ts` on every request, cached by VersionId so rotation needs no restart, and `grafana-cloud/otlp-auth` by `src/handlers/webhook-otel-init.ts`, only when the OTLP endpoint has been repointed at an authenticated gateway.

## Pod identity

One IAM role serves the whole Platform, all operator-generated from the Platform CR — plus a minted invoke role for EventBridge Scheduler:

| Role | Owner | Trust | Used by |
|---|---|---|---|
| `<env>-incident-response-tenant` | eks-agent-platform operator | `system:serviceaccount:tenants-incident-response:tenant-runtime` | webhook + processor pods, and any AgentFleet pods |
| `<env>-incident-response-scheduler-invoke` | eks-agent-platform operator | `scheduler.amazonaws.com` | EventBridge Scheduler, to deliver nudges into the tenant's own queues |

The tenant role's permissions are all operator-owned: the agent-iam Bedrock baseline clamped to `spec.identity.allowedModels`, the datastore-access policy from `spec.datastores`, the capability-access policy (EventBridge Scheduler) from `spec.identity.capabilities`, and the tenant's own `incident-response/<env>/*` secret prefix.

The chart's `serviceaccount.yaml` references the operator-owned `tenant-runtime` ServiceAccount (`serviceAccount.create: false`) with no role-arn annotation. The operator creates the Pod Identity association binding `(namespace, tenant-runtime)` to the role, so EKS injects credentials through the standard AWS credential chain — no annotation, no role ARN in the chart.

## Render locally

```sh
helm lint chart
helm template incident-response chart -f chart/values-staging.yaml
```

## Substrate boundaries

Three layers meet at this chart. Anything in the right-hand column does not belong in `chart/templates/`:

| Concern | Owner |
|---|---|
| Both Deployments, their Services, the public Ingress, the ServiceAccount, the NetworkPolicy, the ExternalSecret, the PrometheusRule, the GrafanaDashboard CR | this chart |
| VPC, subnets, NAT | landing-zone `network` |
| DynamoDB tables, SQS FIFO queues + DLQs, S3 audit bucket (declared in `spec.datastores`) | landing-zone `tenant-substrate` |
| The tenant IAM role + Pod Identity association, the datastore-access + capability-access policies, and the scheduler-invoke role | eks-agent-platform operator |
| Secrets Manager entries the ExternalSecret reads | landing-zone `tenant-substrate`, seeded by `scripts/seed-secrets.sh` |
| Account-level Bedrock invocation-logging-NONE | landing-zone `cluster-bootstrap` |
| cert-manager, External Secrets Operator, external-dns, the AWS Load Balancer Controller | eks-gitops |
| The `alb` IngressClass `webhook-ingress.yaml` requests, and the ACM certificate TLS terminates against | the AWS Load Balancer Controller in eks-gitops; the certificate is yours to issue |
| the OpenTelemetry Collector — OTLP receiver + pod log tail, fanning out traces → Tempo, metrics → Amazon Managed Prometheus, logs → Loki | eks-gitops |
| The Grafana instance the `GrafanaDashboard` CR reconciles onto, and the grafana-operator that reconciles it | eks-gitops |
| Namespace, ResourceQuota, LimitRange, default-deny NetworkPolicy, AppProject, tenant IAM role | the eks-agent-platform operator, from `platform.yaml` |

The app emits OTLP and structured JSON on stdout/stderr and carries no telemetry sidecars — collection is a cluster capability, not a pod-level one.
