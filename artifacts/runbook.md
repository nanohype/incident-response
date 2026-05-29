# Marshal — SRE Runbook
**Author:** ops-sre  
**Version:** 1.0  
**Last Updated:** 2025-01-15  
**On-call rotation:** Marshal is SRE-owned  

---

## 1. Service Overview

Marshal is an ECS Fargate service (persistent) + Lambda (webhook ingress) + SQS FIFO queue + EventBridge Scheduler + DynamoDB.

**Critical invariant:** Marshal processes P1 incidents. If Marshal is down, incident response falls back to manual.

**Healthy state indicators:**
- ECS task count = 1 (or ≥1 if scaled out)
- SQS incident queue depth = 0 (no unprocessed messages)
- DLQ depth = 0
- CloudWatch alarm `marshal-processor-stopped` = OK

---

## 2. Architecture at a Glance

```
Grafana OnCall → API GW → Lambda (ingress) → SQS FIFO → ECS Fargate (processor)
                                                              ↕
                                                         DynamoDB (state + audit)
                                                              ↕
                                              Slack / WorkOS Directory Sync / Statuspage / Linear / Bedrock
```

---

## 3. SLOs

| SLO | Target | Measurement |
|-----|--------|-------------|
| Webhook ingress availability | 99.9% | Lambda error rate < 0.1% over 30 days |
| War room assembly time (p50) | ≤5 min | Custom metric: `MarshalWarRoomAssemblyMs` p50 |
| War room assembly time (p95) | ≤8 min | Custom metric: `MarshalWarRoomAssemblyMs` p95 |
| Responder invited within 3 min | ≥95% | Custom metric: `MarshalResponderInviteWithin3MinPct` |
| Status page approval gate | 100% | Audit query: published without approval = 0 |
| Postmortem created within 48h | ≥95% | Linear issue create timestamp vs. resolved timestamp |

---

## 4. SLIs and Metrics

Marshal is split across two observability planes:

- **AWS infra metrics (CloudWatch):** Lambda/SQS/ECS/DynamoDB — native AWS telemetry.
- **App metrics + traces (Grafana Cloud):** emitted via OTel through the ADOT collector
  sidecar (ECS) or the in-handler NodeSDK started at cold start (webhook;
  see `src/handlers/webhook-otel-init.ts`). Traces land in Tempo; metrics in Mimir.
  Dashboard JSON and alerting rules live in `infra/dashboards/marshal.json` and
  `infra/alerts/marshal-rules.yaml`.

### Lambda Ingress (CloudWatch)
- `AWS/Lambda/Duration` — p99 should be < 2s
- `AWS/Lambda/Errors` — alert if > 5 in 5 minutes
- `AWS/Lambda/Throttles` — alert if > 0

### SQS Queue (CloudWatch)
- `AWS/SQS/ApproximateNumberOfMessagesVisible` — alert if > 10 (backlog forming)
- `AWS/SQS/ApproximateAgeOfOldestMessage` — alert if > 300s (5 min delay)
- DLQ depth alarm: any message in DLQ = immediate alert

### ECS Fargate (CloudWatch)
- `ECS/ContainerInsights/RunningTaskCount` — alert if < 1
- `ECS/ContainerInsights/CPUUtilization` — alert if > 80%
- `ECS/ContainerInsights/MemoryUtilization` — alert if > 80%

### Application metrics (Grafana Cloud Mimir — OTel)
- `assembly_duration_ms` — histogram; SLO alert on p99 > 5 min (`MarshalAssemblyDurationBreach`)
- `approval_gate_latency_ms` — histogram; IC approval click → Statuspage publish
- `directory_lookup_failure_count` — counter; spike alert (`MarshalDirectoryLookupFailureSpike`)
- `statuspage_publish_count{outcome}` — counter; page alert on `outcome=failed` (`MarshalStatuspagePublishFailures`)
- `incident_resolved_count` — counter
- `postmortem_created_count` — counter

### Distributed traces (Grafana Cloud Tempo — OTel)
Single trace spans the full Grafana OnCall webhook → SQS → ECS assembly flow. Manual spans
inside `WarRoomAssembler.assemble` give per-step timings (`assemble.create_channel`,
`assemble.resolve_responders`, `assemble.invite_responders`, `assemble.post_context`,
`assemble.pin_checklist`, `assemble.schedule_nudge`) — tagged with `incident.id` + `team.id`.

---

## 5. Runbook: Processor is Down

**Alarm:** `marshal-processor-stopped` ALARM  
**Impact:** No new incidents will be processed; existing war rooms will not receive nudges  
**Fallback:** Manual incident response (email/Slack direct notification to SRE on-call)  

**Steps:**
1. Check ECS service status:
   ```bash
   aws ecs describe-services --cluster marshal --services marshal-processor --region us-west-2
   ```
2. Check stopped task reason:
   ```bash
   aws ecs list-tasks --cluster marshal --service-name marshal-processor --desired-status STOPPED
   aws ecs describe-tasks --cluster marshal --tasks <task-arn>
   ```
3. Check processor logs in Grafana Cloud Loki (app logs ship here via the Fluent Bit sidecar):
   ```logql
   {service="marshal-processor"} | json | level=~"warn|error" | __time > now() - 30m
   ```
   If nothing is returned AND the task is running, the forwarder itself is broken — check the
   CloudWatch meta-log group for Fluent Bit's own stderr:
   ```bash
   aws logs tail /marshal/forwarder-diagnostics --since 30m --follow
   ```
4. Common causes:
   - **OOM**: Increase memory in task definition (`memoryLimitMiB`)
   - **Missing env var**: Check `REQUIRED_ENV` list in `src/index.ts`; verify all secrets exist in Secrets Manager
   - **Slack token invalid**: Rotate Slack bot token in Secrets Manager; force new ECS deployment
5. Force new deployment:
   ```bash
   aws ecs update-service --cluster marshal --service marshal-processor --force-new-deployment
   ```
6. Verify recovery: task count returns to 1; test webhook endpoint.

---

## 6. Runbook: SQS DLQ Has Messages

**Alarm:** `marshal-incident-events-dlq-depth` > 0  
**Impact:** One or more incidents failed to process; war rooms were not assembled  

**Steps:**
1. Check DLQ message content (DO NOT DELETE YET):
   ```bash
   aws sqs receive-message \
     --queue-url <dlq-url> \
     --attribute-names All \
     --max-number-of-messages 1
   ```
2. Check processor logs in Grafana Cloud Loki, filtered by incident_id:
   ```logql
   {service="marshal-processor", incident_id="<incident_id>"} | json
   ```
   To pivot from a trace in Tempo: clicking a log line in Loki exposes the `trace_id` field
   (stamped by the logger when a span is active) which jumps directly into the Tempo waterfall
   for that incident.
3. If the incident is still active:
   - Notify the IC via direct Slack message that Marshal failed to assemble the war room
   - Provide the IC with the incident ID and offer to manually assist with room creation
4. Determine root cause from logs
5. Fix root cause (code or config)
6. Redrive messages from DLQ after fix is deployed:
   ```bash
   aws sqs start-message-move-task \
     --source-arn <dlq-arn> \
     --destination-arn <main-queue-arn>
   ```
7. Monitor that messages process successfully.

---

## 7. Runbook: WorkOS Directory Sync Lookup Failures

**Signal:** Marshal metric `directory_lookup_failure_count` > 0 in the 1-min sum widget; audit log events `DIRECTORY_LOOKUP_FAILED`  
**Impact:** Responders are not auto-invited; IC receives fallback error message  

**Steps:**
1. Check if WorkOS is having a service incident: https://status.workos.com
2. Verify Marshal's WorkOS API key is valid:
   ```bash
   KEY=$(aws secretsmanager get-secret-value --secret-id marshal/workos/api-key --query SecretString --output text)
   curl -H "Authorization: Bearer $KEY" https://api.workos.com/directories
   ```
3. If key rotated/revoked: update Secrets Manager value and force a new ECS deployment (ECS pulls secrets on task start)
4. Pre-warm WorkOS directory cache manually if needed (restart ECS task to trigger warm-up)

---

## 8. Runbook: Statuspage.io Publish Failure After Approval

**Signal:** IC reports "Failed to publish status page" in Slack; Loki query `{service="marshal-processor"} |= "Statuspage.io createIncident failed"` shows the failure.  
**Impact:** IC has approved the draft but the page is not yet updated; customers awaiting update  

**Steps:**
1. Verify Statuspage.io API status: https://metastatuspage.com (or Statuspage's own status page)
2. Check API key is valid:
   ```bash
   KEY=$(aws secretsmanager get-secret-value --secret-id marshal/statuspage/api-key --query SecretString --output text)
   PAGE_ID=$(aws secretsmanager get-secret-value --secret-id marshal/statuspage/page-id --query SecretString --output text)
   curl -H "Authorization: OAuth $KEY" https://api.statuspage.io/v1/pages/$PAGE_ID
   ```
3. If Marshal is unavailable, IC can publish manually via Statuspage.io web UI
4. Audit log will show `STATUSPAGE_DRAFT_APPROVED` but no `STATUSPAGE_PUBLISHED` — this is expected for a failed publish
5. Once API is back, IC can retry "Approve & Publish" — the draft remains in `PENDING_APPROVAL`

---

## 9. Monitoring Dashboards

**Grafana Cloud — `marshal-ops`** (dashboard JSON committed at `infra/dashboards/marshal.json`).
Import via Grafana UI (Dashboards → New → Import → Upload JSON) or via the Grafana Cloud API.
Alerting rules live at `infra/alerts/marshal-rules.yaml` and are uploaded to Mimir via the
Ruler API (`mimirtool rules sync --address <mimir-url> --auth-token <token> infra/alerts/marshal-rules.yaml`
or via the Grafana Cloud alerting UI).

Key panels:
- War room assembly p50/p99 (SLO: p99 ≤ 5 min)
- Approval gate latency p50/p99
- Statuspage publishes by outcome
- Directory lookup failure rate
- SQS depth (CloudWatch datasource)
- ECS task health (CloudWatch datasource)
- Lambda ingress duration + errors (CloudWatch datasource)

**CloudWatch** — infrastructure alarms only (`marshal-incident-events-dlq-depth`,
`marshal-processor-stopped`). No dashboard; query via CloudWatch metrics UI if needed.

---

## 10. Cost Monitoring

| Resource | Expected monthly cost |
|----------|-----------------------|
| ECS Fargate (0.5 vCPU / 1GB, ~720h) | ~$30-50 |
| Lambda (webhook ingress, 10 req/month) | < $1 |
| DynamoDB (on-demand, ~5K events/month) | < $5 |
| SQS (FIFO, ~100 messages/month) | < $1 |
| EventBridge Scheduler (~150 rules/month) | < $5 |
| Bedrock (Sonnet ~5K tokens × 20/month) | ~$5-10 |
| Secrets Manager (per-env inventory, ~15 entries) | ~$6/month |
| CloudWatch (Lambda + forwarder-diagnostics meta-group, 1-day retention) | ~$1-2 |
| Grafana Cloud (logs + metrics + traces — see Grafana Cloud pricing) | varies by plan |
| **Total (AWS side)** | **~$50-75/month** |

Alert: ops-finops if monthly AWS bill for Marshal exceeds $150 (2x estimate).

---

## 11. Deployment

```bash
# Prerequisites: AWS credentials, CDK bootstrapped in account/region
cd infra
npm install
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export CDK_DEFAULT_REGION=us-west-2

# Deploy
npx cdk deploy MarshalStack

# Output: WebhookApiUrl — configure in Grafana OnCall integration

# Smoke test: send a test webhook
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Grafana-OnCall-Signature: <hmac-of-body>" \
  -d '{"alert_group_id":"test-001","alert_group":{"id":"test-001","title":"Test Alert","state":"firing"},"integration_id":"int-001","route_id":"route-001","team_id":"team-001","team_name":"SRE","alerts":[{"id":"a-001","title":"Test","message":"Test alert message","received_at":"2025-01-15T00:00:00Z"}]}' \
  <WebhookApiUrl>/webhook/grafana-oncall
```

---

## 12. Secrets Setup (First Deploy)

All secrets are created by CDK with placeholder values. After deploy, populate:

```bash
# Slack
aws secretsmanager put-secret-value --secret-id marshal/slack/bot-token --secret-string "xoxb-..."
aws secretsmanager put-secret-value --secret-id marshal/slack/signing-secret --secret-string "..."

# Grafana OnCall
aws secretsmanager put-secret-value --secret-id marshal/grafana/oncall-token --secret-string "..."

# Grafana Cloud (SEPARATE token from OnCall)
aws secretsmanager put-secret-value --secret-id marshal/grafana/cloud-token --secret-string "..."
aws secretsmanager put-secret-value --secret-id marshal/grafana/cloud-org-id --secret-string "..."

# Statuspage.io
aws secretsmanager put-secret-value --secret-id marshal/statuspage/api-key --secret-string "..."
aws secretsmanager put-secret-value --secret-id marshal/statuspage/page-id --secret-string "..."

# GitHub
aws secretsmanager put-secret-value --secret-id marshal/github/token --secret-string "..."

# Linear
aws secretsmanager put-secret-value --secret-id marshal/linear/api-key --secret-string "..."
aws secretsmanager put-secret-value --secret-id marshal/linear/project-id --secret-string "..."

# WorkOS Directory Sync
aws secretsmanager put-secret-value --secret-id marshal/workos/api-key --secret-string "sk_live_..."

# Grafana OnCall HMAC
aws secretsmanager put-secret-value --secret-id marshal/grafana/oncall-webhook-hmac --secret-string "$(openssl rand -hex 32)"
```

Then force new ECS deployment to pick up the secrets:
```bash
aws ecs update-service --cluster marshal --service marshal-processor --force-new-deployment
```
