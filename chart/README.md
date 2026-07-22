# incident-response chart

Helm chart for the incident-response incident-commander assistant. Renders two workloads + supporting observability resources into a Platform tenant on the `eks-agent-platform` operator:

- **webhook** — `Deployment` + `Service` + `Ingress` (public, cert-manager TLS). Serves three signature-verified HTTP surfaces: Grafana OnCall HMAC-signed P1 events (verify → idempotent DynamoDB write → SQS enqueue), and the Slack slash-command + Block Kit interactivity Request URLs on the `/slack` path prefix (Slack signing-secret verified; `statuspage_approve` runs the 2-phase gate inline with the clicking human's id).
- **processor** — `Deployment` (`Recreate` strategy — single-writer singleton). SQS consumer + war-room assembler + Statuspage approval-gate `createDraft` + Linear postmortem creator + EventBridge Scheduler nudge wrangler, and the in-process streamable-HTTP **MCP server** (the read + draft pull surface) on the `mcp` container port.
- **mcp** — `Service` (ClusterIP) in front of the processor's MCP port. The mcp-tunnel (outbound-only cloudflared) is the only thing allowed to reach it; the NetworkPolicy locks the port to the `mcp-tunnel` namespace. No public ingress.

Plus:

- **PrometheusRule** — three rules under `incident-response.slo`: assembly P99 SLO breach, directory-lookup failure spike, Statuspage publish failures. Off by default (`prometheusRule.enabled: false`): the CR only does something where a Prometheus Operator ruler watches for it, and the eks-gitops observability catalog runs Alloy remote-writing to Amazon Managed Prometheus with no in-cluster ruler. Turn it on — and set `prometheusRule.selector` to whatever that ruler's `ruleSelector` matches — on a cluster that runs one.
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
  - `networkpolicy.yaml` — ingress: the `ingress-nginx` namespace → webhook, mcp-tunnel namespace → processor MCP port; egress: DNS + HTTPS + OTLP
  - `externalsecret.yaml` — pulls incident-response/<env>/grafana-oncall-hmac + app-secrets, composes one Secret consumed by envFrom; the HMAC secret is also referenced by its ARN in env for the handler's VersionId-keyed cache. No OTLP credential is projected — the default export target is the unauthenticated in-cluster Alloy receiver
  - `prometheusrule.yaml` — three alert rules (assembly SLO / directory failures / Statuspage publish failures)
  - `grafana-dashboard.yaml` — GrafanaDashboard CR with the dashboard JSON

## Webhook server entrypoint

`src/handlers/webhook-ingress.ts` exports the ingress handler as a pure function of a request envelope, so it holds no reference to a server. `src/bin/webhook-server.ts` is a thin `node:http` wrapper that reads the body, hands the handler the envelope, and writes the result back; the wrapper owns the transport and adds no runtime dependencies. The chart's webhook Deployment runs `node dist/bin/webhook-server.js`.

## Per-tenant infra (from landing-zone)

Single-tenant component `components/aws/incident-response-platform/` provisions everything incident-response's pods need:

- DynamoDB ×3 — incidents (slack-channel-index + by-timestamp GSIs), audit, identity-cache
- SQS FIFO ×6 — incident-events / nudge-events / sla-check (+ DLQs)
- EventBridge Scheduler group + ScheduleRole IAM role
- S3 audit-archive bucket
- IAM role with the consolidated inline policy (DDB rw, SQS rw, Bedrock invoke for Claude Sonnet 4.6 + Haiku 4.5, EventBridge Scheduler crud, Secrets Manager read)

Bedrock invocation-logging-NONE is a Bedrock account+region scoped policy, so it belongs to landing-zone's `cluster-bootstrap` component rather than to any single tenant; the reasoning is in `eks-agent-platform/ARCHITECTURE.md`.

Secrets Manager entries (`incident-response/<env>/grafana-oncall-hmac`, `app-secrets`, `grafana-cloud/otlp-auth`) are seeded by this repo's own `scripts/seed-secrets.sh`. The ExternalSecret projects the first two; `grafana-cloud/otlp-auth` is read through the AWS SDK by `src/handlers/webhook-otel-init.ts` and only when the OTLP endpoint has been repointed at an authenticated gateway.

## Pod identity

Two IAM roles exist for any incident-response Platform tenant — different SAs, different policies, different owners:

| Role | Owner | Trust | Used by |
|---|---|---|---|
| `<env>-incident-response-platform` | landing-zone `incident-response-platform` component | `system:serviceaccount:tenants-incident-response:incident-response` | This chart's webhook + processor pods |
| `<env>-incident-response-tenant` | eks-agent-platform operator | `system:serviceaccount:tenants-incident-response:tenant-runtime` | AgentFleet pods (if/when any land in this Platform) |

The chart's `serviceaccount.yaml` creates a ServiceAccount named `incident-response` (pinned via `serviceAccount.name`) with no role-arn annotation. The landing-zone `incident-response-platform` component creates an EKS Pod Identity association binding that `(namespace, service-account)` to the IAM role, so EKS injects credentials through the standard AWS credential chain — no annotation, no role ARN in the chart. The ServiceAccount name must match the association's `service_account`, which is why it is pinned to the app name.

The operator-managed role is unused by this chart today and is harmless. It only matters once an AgentFleet CR lands in the `incident-response` Platform.

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
| DynamoDB tables, SQS FIFO queues + DLQs, EventBridge Scheduler group + ScheduleRole, S3 audit bucket, the app IAM role and its Pod Identity association | landing-zone `incident-response-platform` |
| Secrets Manager entries the ExternalSecret reads | landing-zone `incident-response-platform`, seeded by `scripts/seed-secrets.sh` |
| Account-level Bedrock invocation-logging-NONE | landing-zone `cluster-bootstrap` |
| cert-manager, External Secrets Operator, external-dns, the AWS Load Balancer Controller | eks-gitops |
| An ingress controller serving `ingress.className` (default `nginx`) — the eks-gitops catalog has none, so the rendered `Ingress` gets no address until one is added or the class is changed | **not provided** |
| Grafana Alloy — OTLP receiver + pod log tail, fanning out traces → Tempo, metrics → Amazon Managed Prometheus, logs → Loki | eks-gitops |
| The Grafana instance the `GrafanaDashboard` CR reconciles onto, and the grafana-operator that reconciles it | eks-gitops |
| Namespace, ResourceQuota, LimitRange, default-deny NetworkPolicy, AppProject, tenant IAM role | the eks-agent-platform operator, from `platform.yaml` |

The app emits OTLP and structured JSON on stdout/stderr and carries no telemetry sidecars — collection is a cluster capability, not a pod-level one.
