# IncidentResponse — SRE Runbook

**Owner:** SRE
**Scope:** day-2 operation of the incident-response Platform tenant

This is the day-2 companion to [`docs/troubleshooting.md`](../docs/troubleshooting.md). Troubleshooting is symptom-indexed — "this error appeared, what now". This runbook is alert-indexed: the SLOs, the signals that back them, and the response to each page.

All `kubectl` examples assume `-n tenants-incident-response`.

---

## 1. Service overview

Two Deployments in one tenant namespace, fed by AWS data services the tenant does not own:

```
Grafana OnCall ─┐
Slack ──────────┴─► ingress-nginx ─► webhook Deployment (2+ replicas, stateless)
                                             │ HMAC / Slack signature verify
                                             │ idempotent DynamoDB write
                                             ▼
                                      SQS FIFO (incident-events)
                                             │
                                             ▼
                              processor Deployment (replicas: 1, Recreate)
                                             ↕
                                   DynamoDB (state + audit)
                                             ↕
                   Slack / WorkOS / Grafana Cloud / Statuspage / Linear / Bedrock
```

**Critical invariant:** this service handles P1 incidents. If it is down, incident response falls back to manual — page the SRE on-call and tell the IC directly.

**Healthy state:**

- `kubectl get deploy` shows `incident-response-webhook` at its configured replica count and `incident-response-processor` at `1/1`
- SQS `incident-events` visible-message count at 0, DLQ at 0
- The ArgoCD `incident-response-<env>` Application is `Synced` + `Healthy`
- No firing alerts from the `incident-response.slo` PrometheusRule group

The processor is a **single-writer singleton**. Two processors would each poll SQS and dispatch the same event, producing a second Slack war room and duplicate audit writes. That is why it runs `replicas: 1` with `strategy: Recreate` — never scale it up, and never switch it to `RollingUpdate`.

---

## 2. SLOs

| SLO | Target | Measurement |
|-----|--------|-------------|
| Webhook ingress availability | 99.9% | 5xx rate on the webhook Deployment's OTel HTTP server series over 30 days |
| War room assembly time (p50) | ≤ 5 min | `incident_response_assembly_duration_ms` p50 |
| War room assembly time (p95) | ≤ 8 min | `incident_response_assembly_duration_ms` p95 |
| Responder invited within 3 min | ≥ 95% | `incident_response_assembly_duration_ms` bucketed against the invite span |
| Statuspage approval gate | 100% | Audit query: published without approval = 0 (`auditApprovalGateViolations()`) |
| Postmortem created within 48h | ≥ 95% | Linear issue create timestamp vs. resolved timestamp |

---

## 3. Signals

Telemetry lands in two places, and knowing which one to open saves the first five minutes of any page.

- **App metrics + traces + logs** — the pods emit OTLP and structured JSON; Grafana Alloy, installed by `eks-gitops`, forwards traces to the in-cluster Tempo, metrics to Amazon Managed Prometheus, and logs to the in-cluster Loki. No per-pod sidecars. The dashboard (`chart/dashboards/incident-response.json`) and the three alert rules (`chart/templates/prometheusrule.yaml`) ship with the chart.
- **AWS data-service metrics** — SQS depth, DynamoDB throttles and the EventBridge Scheduler are CloudWatch-native, surfaced on the dashboard through the CloudWatch datasource.

### Application metrics

- `incident_response_assembly_duration_ms` — histogram; SLO alert on p99 > 5 min (`IncidentResponseAssemblyDurationBreach`)
- `incident_response_approval_gate_latency_ms` — histogram; IC approval click → Statuspage publish
- `incident_response_directory_lookup_failure_count` — counter; spike alert (`IncidentResponseDirectoryLookupFailureSpike`)
- `incident_response_statuspage_publish_count{outcome}` — counter; page alert on `outcome=failed` (`IncidentResponseStatuspagePublishFailures`)
- `incident_response_incident_resolved_count`, `incident_response_postmortem_created_count` — counters

### Workload health

- `kube_deployment_status_replicas_ready` — the processor floor is 1; a sustained 0 is an outage
- `kube_pod_container_status_restarts_total` — a climbing restart count on the processor usually means OOM or a failed config parse at startup

### Queues

- `ApproximateNumberOfMessagesVisible` — alert above 10, a backlog is forming
- `ApproximateAgeOfOldestMessage` — alert above 300s, the visibility timeout is cycling
- DLQ depth — any message at all is an immediate page

### Traces

One trace spans the whole webhook → SQS → processor flow; the W3C context rides across the hop in SQS message attributes. Manual spans inside `WarRoomAssembler.assemble` give per-step timings (`assemble.create_channel`, `assemble.resolve_responders`, `assemble.invite_responders`, `assemble.post_context`, `assemble.pin_checklist`, `assemble.schedule_nudge`), tagged with `incident.id` and `team.id`. Log lines carry `trace_id`, so a Loki line jumps straight into the Tempo waterfall.

---

## 4. Processor is down

**Signal:** processor ready replicas at 0, or a climbing `CrashLoopBackOff`
**Impact:** no new incidents processed, no nudges fired on live war rooms
**Fallback:** manual incident response — notify the SRE on-call directly

1. Look at the pod and the reason it is not running:

   ```bash
   kubectl -n tenants-incident-response get pods -l app.kubernetes.io/component=processor
   kubectl -n tenants-incident-response describe pod <pod>
   ```

2. Read the logs, including the previous container if it restarted:

   ```bash
   kubectl -n tenants-incident-response logs deploy/incident-response-processor --since=30m
   kubectl -n tenants-incident-response logs deploy/incident-response-processor --previous --since=30m
   ```

   If the pod is `Running` and the logs are empty in Loki but present here, Alloy's log tail is the broken piece, not the app — that is an `eks-gitops` problem.

3. Common causes:
   - **OOMKilled** — `describe pod` shows `Reason: OOMKilled`. Raise `processor.resources.limits.memory` in `chart/values-<env>.yaml`.
   - **Missing env** — logs show `Required env not set: X` or a `ZodError`. A secret is absent or empty; re-seed with `npm run seed:<env>` and check the ExternalSecret is `Ready`.
   - **Invalid Slack token** — rotate in Secrets Manager, then restart so the pod picks up the reprojected Secret.

4. Restart once the cause is fixed:

   ```bash
   kubectl -n tenants-incident-response rollout restart deploy/incident-response-processor
   kubectl -n tenants-incident-response rollout status  deploy/incident-response-processor
   ```

   `Recreate` means the old pod terminates before the new one starts — expect a short gap, and do not try to shorten it by scaling up.

5. Verify recovery: ready replicas back at 1, queue depth draining, and a drill (`npm run drill:<env>`) reaching Slack.

---

## 5. SQS DLQ has messages

**Signal:** DLQ depth > 0
**Impact:** one or more incidents failed to process; those war rooms were never assembled

1. Inspect a message without deleting it:

   ```bash
   aws sqs receive-message --queue-url <dlq-url> --attribute-names All --max-number-of-messages 1
   ```

2. Find the matching processor logs by incident id:

   ```bash
   kubectl -n tenants-incident-response logs deploy/incident-response-processor --since=2h \
     | grep '"incident_id":"<incident_id>"'
   ```

   Or in Loki: `{namespace="tenants-incident-response", pod=~"incident-response.*"} | json | incident_id="<incident_id>"`.

3. **If the incident is still live, handle the human side first.** Direct-message the IC that the war room was not assembled, give them the incident id, and offer to create the channel by hand. Root cause can wait; the incident cannot.

4. Determine the root cause from the logs, fix it, and roll out the fix.

5. Redrive once the fix is live:

   ```bash
   aws sqs start-message-move-task --source-arn <dlq-arn> --destination-arn <main-queue-arn>
   ```

6. Watch the main queue drain and confirm the incidents assemble.

---

## 6. WorkOS Directory Sync lookup failures

**Signal:** `incident_response_directory_lookup_failure_count` rising; `DIRECTORY_LOOKUP_FAILED` audit events
**Impact:** responders are not auto-invited and the IC gets an explicit fallback message — never a half-assembled room presented as complete

1. Check whether WorkOS itself is degraded: <https://status.workos.com>.
2. Verify the key still works:

   ```bash
   KEY=$(aws secretsmanager get-secret-value --secret-id incident-response/<env>/app-secrets \
     --query SecretString --output text | jq -r '.["workos/api-key"]')
   curl -H "Authorization: Bearer $KEY" https://api.workos.com/directories
   ```

3. If the key was rotated or revoked, put the new value into Secrets Manager and restart the processor so the reprojected Secret reaches the running pod.
4. The client holds a 5-minute per-instance cache with stale-fallback behind a circuit breaker, so a brief WorkOS outage degrades rather than fails. A restart clears that cache — only restart if the credential actually changed.

---

## 7. Statuspage publish failed after approval

**Signal:** the IC reports a failed publish; processor logs carry `Statuspage.io publish failed after approval`
**Impact:** the IC approved a draft that customers cannot see yet

1. Check Statuspage's own status page.
2. Verify the credentials:

   ```bash
   SECRET=$(aws secretsmanager get-secret-value --secret-id incident-response/<env>/app-secrets \
     --query SecretString --output text)
   KEY=$(jq -r '.["statuspage/api-key"]' <<<"$SECRET")
   PAGE_ID=$(jq -r '.["statuspage/page-id"]' <<<"$SECRET")
   curl -H "Authorization: OAuth $KEY" "https://api.statuspage.io/v1/pages/$PAGE_ID"
   ```

3. While the API is unavailable the IC can publish by hand in the Statuspage UI.
4. The audit log will show `STATUSPAGE_DRAFT_APPROVED` with no `STATUSPAGE_PUBLISHED`. That is the correct record of a failed publish, not a gate violation — the gate writes the approval before it calls Statuspage, on purpose.
5. Once the API recovers the IC can click "Approve & Publish" again; the draft is still `PENDING_APPROVAL`.

---

## 8. Approval-gate audit

The gate is the property the product hangs on, so verify it rather than trusting it. `auditApprovalGateViolations()` in `src/utils/audit.ts` queries the `published-without-approval-index` GSI for any `STATUSPAGE_PUBLISHED` event with no preceding `STATUSPAGE_DRAFT_APPROVED` for the same incident. The expected result is always zero rows. A non-zero result is a security incident, not a bug report: capture the audit rows before anything else, since they are the evidence.

CI keeps the invariant honest from the other direction — a grep-gate fails the build on any `createIncident()` call site outside `src/services/statuspage-approval-gate.ts`, and that file plus `src/utils/audit.ts` are pinned at 100% branch coverage.

---

## 9. Dashboards + alerts

Both ship from the chart; there is no manual import step.

- **Dashboard** — `chart/dashboards/incident-response.json`, delivered as a `GrafanaDashboard` CR that the grafana-operator reconciles onto the Grafana instance. Panels: assembly p50/p99, approval-gate latency, Statuspage publishes by outcome, directory-lookup failure rate, SQS depth, pod availability and restarts, webhook duration + 5xx rate, and a Loki panel over both Deployments.
- **Alerts** — `chart/templates/prometheusrule.yaml`, three rules under `incident-response.slo`. Off by default: `eks-gitops` runs no Prometheus operator, so on that stack the CR applies and sits inert. Alert rules against the AMP workspace are owned by `landing-zone`'s `managed-monitoring` component.

Editing either means editing the file in the chart and letting ArgoCD roll it out. Changes made in the Grafana UI are reverted on the next reconcile.

---

## 10. Cost

The tenant's spend is bounded by the `BudgetPolicy` in `platform.yaml`: a USD 2500/month soft cap, alerts at 50/80/100%, and a kill-switch that fires at 120%.

| Resource | Expected monthly cost |
|----------|-----------------------|
| Pods (webhook 2× small + processor 1× small, on the shared cluster) | node-share, no dedicated capacity |
| DynamoDB (on-demand, ~5K events/month) | < $5 |
| SQS (FIFO, ~100 messages/month) | < $1 |
| EventBridge Scheduler (~150 rules/month) | < $5 |
| Bedrock (Sonnet ~5K tokens × 20/month, Haiku classification) | ~$5-10 |
| Secrets Manager (per-env inventory, ~15 entries) | ~$6 |
| S3 audit archive | < $1 |

Escalate to finance if the tenant's attributed spend exceeds 2× the estimate outside of a real incident surge — sustained Bedrock cost is the line item most likely to move.

---

## 11. Deploy + rollback

ArgoCD owns the rollout. A deploy is a commit that bumps `image.tag` in `chart/values-<env>.yaml`; a rollback is the commit that puts the old tag back. Nothing is applied by hand.

```bash
kubectl -n tenants-incident-response rollout status deploy/incident-response-webhook
kubectl -n tenants-incident-response rollout status deploy/incident-response-processor
```

First-time setup — landing-zone substrate, the Platform CR, secret seeding, the ApplicationSet entry and the Grafana OnCall webhook wiring — is [`docs/deployment-guide.md`](../docs/deployment-guide.md). Secret inventory and rotation is [`docs/secrets.md`](../docs/secrets.md). Drills are [`docs/drills.md`](../docs/drills.md) and [`artifacts/incident-drill-playbook.md`](incident-drill-playbook.md).
