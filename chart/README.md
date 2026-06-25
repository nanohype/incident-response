# incident-response chart

Helm chart for the incident-response incident-commander assistant. Renders two workloads + supporting observability resources into a Platform tenant on the `eks-agent-platform` operator:

- **webhook** — `Deployment` + `Service` + `Ingress` (public, cert-manager TLS). Receives Grafana OnCall HMAC-signed P1 events, verifies the signature, idempotently writes to DynamoDB, enqueues to SQS. Replaces the CDK Lambda + API Gateway pair.
- **processor** — `Deployment` (`Recreate` strategy — Slack socket-mode is a singleton). Long-running daemon: Slack socket-mode client + SQS consumer + war-room assembler + Statuspage approval gate + Linear postmortem creator + EventBridge Scheduler nudge wrangler. Replaces the CDK ECS Fargate service.

Plus:

- **PrometheusRule** — ported verbatim from `infra/alerts/incident-response-rules.yaml`. Three rules under `incident-response.slo`: assembly P99 SLO breach, directory-lookup failure spike, Statuspage publish failures. Operator-side ruleSelector label is configurable in values (`prometheusRule.selector`).
- **GrafanaDashboard CR** — sourced from `chart/dashboards/incident-response.json`. A `GrafanaDashboard` CR (instanceSelector `dashboards: external`) the grafana-operator reconciles onto the external Amazon Managed Grafana.

## Files

- `Chart.yaml`, `values.yaml`, `values-{staging,production}.yaml`
- `dashboards/incident-response.json` — Grafana dashboard JSON, materialized into the dashboard ConfigMap at render time
- `templates/`
  - `_helpers.tpl` — name/label helpers + shared `incident-response.env` partial
  - `webhook-deployment.yaml`, `webhook-service.yaml`, `webhook-ingress.yaml`
  - `processor-deployment.yaml`
  - `serviceaccount.yaml` — single SA shared across both workloads
  - `networkpolicy.yaml` — ingress: ingress-nginx → webhook only; egress: DNS + HTTPS
  - `externalsecret.yaml` — pulls incident-response/<env>/grafana-oncall-hmac + app-secrets + grafana-cloud, composes one Secret consumed by envFrom; the HMAC secret is also referenced by its ARN in env for the handler's VersionId-keyed cache
  - `prometheusrule.yaml` — three alert rules (assembly SLO / directory failures / Statuspage publish failures)
  - `grafana-dashboard.yaml` — GrafanaDashboard CR with the dashboard JSON

## App-source addition

The CDK era had a Lambda for the webhook ingress (`src/handlers/webhook-ingress.ts`, exporting an `APIGatewayProxyHandlerV2`). The k8s migration adds `src/bin/webhook-server.ts` — a thin `node:http` wrapper that mounts the same handler on a POST endpoint at the configured port. No new runtime dependencies; the handler module itself is unchanged. The chart's webhook Deployment runs `node dist/bin/webhook-server.js`.

## Per-tenant infra (from landing-zone)

Single-tenant component `components/aws/incident-response-platform/` provisions everything incident-response's pods need:

- DynamoDB ×3 — incidents (slack-channel-index + by-timestamp GSIs), audit, identity-cache
- SQS FIFO ×6 — incident-events / nudge-events / sla-check (+ DLQs)
- EventBridge Scheduler group + ScheduleRole IAM role
- S3 audit-archive bucket
- IAM role with the consolidated inline policy (DDB rw, SQS rw, Bedrock invoke for Claude Sonnet 4.6 + Haiku 4.5, EventBridge Scheduler crud, Secrets Manager read, CloudWatch PutMetricData)

The Bedrock invocation-logging-NONE setting is a Bedrock account+region scoped policy — the CDK era enforced it via a custom resource per stack. In the k8s world it belongs to landing-zone's `cluster-bootstrap` (or a new `bedrock-account-config`) component, NOT per-tenant; the operator-side decision is documented in `eks-agent-platform/ARCHITECTURE.md`.

Secrets Manager entries (`incident-response/<env>/grafana-oncall-hmac`, `app-secrets`, `grafana-cloud`) are still seeded via incident-response's own `scripts/seed-secrets.sh` — operator tooling unchanged from the CDK era.

## Pod identity

Two IAM roles exist for any incident-response Platform tenant — different SAs, different policies, different owners:

| Role | Owner | Trust | Used by |
|---|---|---|---|
| `<env>-incident-response-platform` | landing-zone `incident-response-platform` component | `system:serviceaccount:tenants-protohype:incident-response` | This chart's webhook + processor pods |
| `<env>-incident-response-tenant` | eks-agent-platform operator | `system:serviceaccount:tenants-protohype:tenant-runtime` | AgentFleet pods (if/when any land in this Platform) |

The chart's `serviceaccount.yaml` creates a ServiceAccount named `incident-response` (pinned via `serviceAccount.name`) with no role-arn annotation. The landing-zone `incident-response-platform` component creates an EKS Pod Identity association binding that `(namespace, service-account)` to the IAM role, so EKS injects credentials through the standard AWS credential chain — no annotation, no role ARN in the chart. The ServiceAccount name must match the association's `service_account`, which is why it is pinned to the app name.

The operator-managed role is unused by this chart today and is harmless. It only matters once an AgentFleet CR lands in the `incident-response` Platform.

## Render locally

```sh
helm lint chart
helm template incident-response chart -f chart/values-staging.yaml
```

## What changed vs. the CDK stack

The CDK stack (`infra/`, deleted) provisioned:

- VPC + private subnets + NAT → landing-zone `network` component
- ECS Fargate (long-running processor) → `processor-deployment.yaml` in this chart
- Lambda webhook ingress + API Gateway + custom domain → `webhook-deployment.yaml` + `webhook-service.yaml` + `webhook-ingress.yaml` (the Lambda handler is wrapped by `src/bin/webhook-server.ts`)
- ALB + ACM cert → ingress-nginx + cert-manager (gitops-managed)
- DynamoDB ×2 (+ slack-channel-index GSI) → landing-zone `governance` component
- SQS FIFO ×3 (+ DLQs) → landing-zone `pipeline` component
- EventBridge Scheduler group + ScheduleRole → landing-zone scheduler component (new)
- CDK custom resource for Bedrock invocation-logging-NONE → landing-zone `cluster-bootstrap` cluster-wide setting
- Secrets Manager entries → ExternalSecret syncing the existing AWS Secrets Manager source into a k8s Secret
- ADOT Collector sidecar + Fluent Bit FireLens sidecar → OTLP to the grafana-agent receiver in the monitoring namespace (eks-gitops), which forwards traces → Tempo, metrics → AMP, logs → Loki
- CloudWatch alarms → the same three rules now ship as PrometheusRule
- Grafana dashboard provisioner construct → GrafanaDashboard CR reconciled by the grafana-operator onto Amazon Managed Grafana
