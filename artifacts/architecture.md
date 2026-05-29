# Marshal — System Architecture
**Author:** engineering  
**Version:** 1.0  
**Deploy target:** AWS  
**Last Updated:** 2025-01-15

---

## 1. Architecture Overview

Marshal is a TypeScript/Node 24 backend service with no user-facing web interface. All user interaction flows through Slack. The system is event-driven: Grafana OnCall webhooks fire incidents, DynamoDB streams propagate state changes, and EventBridge schedules nudges and SLA checks.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  External Systems                                                        │
│                                                                          │
│  Grafana OnCall ──webhook──►  API Gateway + Lambda (Ingress)            │
│  Slack ◄────────────────────  Marshal Core Service (ECS Fargate)        │
│  Slack ────────────event──►   Marshal Core Service                      │
│  WorkOS Directory Sync ◄────────────────────   Marshal Core Service (WorkOS Directory Sync API)    │
│  GitHub ◄──────────────────   Marshal Core Service (github MCP)         │
│  Grafana Cloud ◄───────────   Marshal Core Service (REST direct)        │
│  Statuspage.io ◄───────────   Marshal Core Service (REST direct)        │
│  Linear ◄──────────────────   Marshal Core Service (linear MCP)         │
│  Bedrock ◄─────────────────   Marshal Core Service (Bedrock runtime)    │
│                                                                          │
│  DynamoDB ◄────────────────►  Marshal Core Service (state + audit)      │
│  Secrets Manager ◄─────────   All components                            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Design

### 2.1 Webhook Ingress Lambda

**Template:** `ts-service` (Lambda variant)  
**Runtime:** Node 24, ARM64 (Graviton)  
**Trigger:** API Gateway HTTP API (POST /webhook/grafana-oncall)

Responsibilities:
- HMAC-SHA256 signature verification of Grafana OnCall webhook payload
- Payload validation (Zod schema)
- Idempotency check: query DynamoDB for existing incident with `alert_group_id` to prevent duplicate war rooms
- Enqueue validated event to SQS FIFO queue (per-incident message group for ordering)
- Return 200 immediately (Grafana OnCall requires a fast response)

**Why Lambda:** Stateless, event-driven, auto-scales to zero between incidents, cold-start acceptable (≤500ms for Lambda SnapStart-eligible function or pre-warmed provisioned concurrency during business hours).

### 2.2 Incident Processor (Core Service)

**Template:** `worker-service` (ECS Fargate long-running worker)  
**Runtime:** Node 24, ARM64  
**Trigger:** SQS FIFO queue consumer; also Slack event listener (via Slack socket mode or Events API)

This is the brain of Marshal. It:
- Consumes SQS events (new incident alerts, Grafana OnCall resolve events)
- Manages incident state machine (DynamoDB-backed)
- Orchestrates the war-room assembly sequence
- Handles Slack interactive message callbacks (approval buttons, silence buttons, rating buttons)
- Manages the 15-minute nudge scheduler (EventBridge Scheduler rules per active incident)
- Drives the Bedrock AI layer for draft composition

**Why ECS Fargate (not Lambda):** The Slack socket-mode WebSocket connection requires a long-lived process. Also, the 15-min nudge scheduler creates/deletes per-incident EventBridge rules which is best managed by a persistent process with clear lifecycle ownership.

**Alternative considered:** Lambda + SQS for all events, Slack Events API (webhook) instead of socket mode. Rejected because: Slack Events API requires a public HTTPS endpoint with retry semantics that complicate idempotency; socket mode is simpler for a single-workspace v1.

### 2.3 Incident State Machine

**Backend:** DynamoDB single-table design  
**State transitions:**

```
ALERT_RECEIVED → ROOM_ASSEMBLING → ROOM_ASSEMBLED → ACTIVE → MITIGATED → RESOLVED
                                        ↓
                              ASSEMBLY_FAILED (WorkOS Directory Sync error)
                                        ↓
                              IC_MANUAL_ASSEMBLY
```

**DynamoDB Table: `marshal-incidents`**

| Attribute | Type | Description |
|-----------|------|-------------|
| PK | String | `INCIDENT#{incident_id}` |
| SK | String | `EVENT#{timestamp_ms}#{event_type}` |
| incident_id | String | Grafana OnCall `alert_group_id` |
| event_type | String | Enum of all incident events |
| event_data | Map | Event-specific payload |
| correlation_id | String | incident_id (threads all events) |
| TTL | Number | Unix epoch + 366 days |

**GSI: `event-type-index`**  
- PK: `event_type`  
- SK: `created_at`  
- Used for: audit queries (e.g., find all `STATUSPAGE_PUBLISHED` events without corresponding `STATUSPAGE_APPROVED` events)

**DynamoDB Table: `marshal-audit`** (separate table for 1-year retention audit log)

| Attribute | Type | Description |
|-----------|------|-------------|
| PK | String | `INCIDENT#{incident_id}` |
| SK | String | `AUDIT#{timestamp_ms}#{action_type}` |
| action_type | String | Enum: WAR_ROOM_CREATED, RESPONDER_INVITED, STATUS_UPDATE_SENT, STATUSPAGE_DRAFT_CREATED, STATUSPAGE_APPROVED, STATUSPAGE_PUBLISHED, POSTMORTEM_CREATED, IC_RATED, REMINDER_SILENCED, etc. |
| actor_user_id | String | Slack user ID of the actor (or "MARSHAL" for automated actions) |
| timestamp | String | ISO 8601 |
| details | Map | Action-specific details (channel_id, draft_sha256, linear_issue_id, etc.) |
| TTL | Number | Unix epoch + 366 days |

**PITR:** Enabled on both tables. DynamoDB Streams enabled on `marshal-incidents` for downstream processing.

### 2.4 AI Layer

**Template:** `module-llm` + `prompt-library`

Two Bedrock models:
- `claude-sonnet-4-6` — status page drafts, postmortem narrative sections
- `claude-haiku-4-5` — message classification (IC status update detection), checklist phase routing, intent detection for slash commands

**Prompt caching strategy:**
- System prompts for both models are cached (Anthropic prompt caching via Bedrock)
- Status draft template prompt: ~2000 tokens, cached per session
- Postmortem template prompt: ~3000 tokens, cached per session
- Incident context (variable data) passed as user-turn content, not cached

**Invocation logging:** `PutModelInvocationLoggingConfiguration` in CDK stack — set to NONE for the deployment region.

**Guardrails:**
- Status draft post-processing: strip any customer-identifying patterns (regex scan for email addresses, account IDs matching `cust-[0-9]+`, internal hostnames)
- Max output tokens: 500 for status drafts, 2000 for postmortem sections
- If Bedrock times out or returns error: present IC with a template with `[describe impact here]` placeholders; never block the incident flow

### 2.5 External Integrations

All external clients share a common wrapper with:
- Timeout: 5s max (AbortSignal.timeout(5000))
- Retry: exponential backoff with jitter, max 2 attempts
- Circuit breaker: after 3 consecutive failures, open circuit for 30s; log circuit-breaker event to CloudWatch and audit log
- Per-client metrics: CloudWatch custom metric for latency histogram and error rate per integration name

| Integration | Client | Auth |
|-------------|--------|------|
| Grafana OnCall | REST (node-fetch + custom wrapper) | Bearer token from Secrets Manager |
| Grafana Cloud (Mimir/Loki/Tempo) | REST (node-fetch + custom wrapper) | Bearer token from Secrets Manager (separate from OnCall token) |
| Slack | @slack/bolt + @slack/web-api | Bot token from Secrets Manager; socket mode |
| Statuspage.io | REST (node-fetch + custom wrapper) | API key from Secrets Manager |
| GitHub | Octokit (github MCP or direct) | App installation token from Secrets Manager |
| Linear | Linear SDK (linear MCP client) | API key from Secrets Manager |
| WorkOS Directory Sync | REST (node-fetch + custom wrapper) | API token from Secrets Manager |
| Bedrock | @aws-sdk/client-bedrock-runtime | IAM role (ECS task role) |
| DynamoDB | @aws-sdk/client-dynamodb + @aws-sdk/lib-dynamodb | IAM role (ECS task role) |

### 2.6 Infrastructure

**Template:** `infra-aws` (CDK v2)

Resources:
- **API Gateway HTTP API** — webhook ingress endpoint
- **Lambda** (Ingress) — webhook handler, SnapStart enabled (Node 24)
- **SQS FIFO Queue** — incident event queue with message groups per incident_id
- **ECS Fargate Cluster** — incident processor, Spot capacity for cost optimization; Fargate on-demand fallback
- **DynamoDB** — `marshal-incidents` + `marshal-audit` (both on-demand billing, PITR on)
- **Secrets Manager** — all external API tokens; rotation policy per token type
- **EventBridge Scheduler** — per-incident nudge timers; SLA check rules
- **CloudWatch** — structured JSON logs, custom metrics dashboard, alarms
- **IAM** — least-privilege task role; no admin, no remediation permissions; explicit Deny for EC2/RDS/S3-write/EKS
- **Bedrock** — model access via task role; invocation logging NONE

**VPC:** Not required for v1 (all external integrations are SaaS; DynamoDB and Bedrock via VPC endpoints optional but not required for v1 at moderate budget).

---

## 3. Key Design Decisions

### D1: DynamoDB event-stream over a relational DB
Chosen because: incident timelines are append-only (event-sourced), queries are primarily by incident_id, and DynamoDB's TTL handles the 1-year retention automatically. The audit log benefits from the same pattern. No joins needed; the incident timeline is a projection of all events for a given incident_id.

### D2: ECS Fargate for core processor (not Lambda)
Chosen because: Slack socket-mode WebSocket requires a persistent connection. The complexity of managing WebSocket reconnects in Lambda invocations outweighs the cost savings. At 10 incidents/month, the Fargate task is nearly idle between incidents — acceptable at moderate budget.

### D3: SQS FIFO between ingress Lambda and processor
Ensures exactly-once processing per alert_group_id (SQS FIFO deduplication ID = alert_group_id). Decouples the ingress latency (Lambda fast-response to Grafana OnCall) from the processing latency.

### D4: EventBridge Scheduler for nudges (not in-process timers)
An in-process 15-minute timer would be lost on ECS task restart. EventBridge Scheduler rules persist across restarts. Each rule fires to an SQS queue which the processor consumes. Rule is created at war-room-assembled and deleted at incident-resolved.

### D5: Separate Bedrock model for classification (haiku-4-5) and generation (sonnet-4-6)
Classification (is this message an IC status update?) is called on every message in the war room — needs to be cheap and fast. haiku-4-5 is ~10x cheaper and ~3x faster than sonnet-4-6. Generation (status draft, postmortem) is called infrequently; quality matters more than cost.

### D6: Approval-gate as database invariant (not code logic)
The Statuspage.io publish function reads the DynamoDB audit table for `STATUSPAGE_APPROVED` record before calling the publish API. If the record is absent, the function throws `AutoPublishNotPermitted`. This means even a code path that somehow bypasses the normal approval flow (e.g., a misconfigured slash command handler) cannot publish, because the database check is independent.

---

## 4. Data Flow — P1 Alert to War Room Assembled

```
1. Grafana OnCall fires webhook
      │
      ▼
2. API Gateway (HTTP) → Ingress Lambda
      │ HMAC verify, Zod validate, idempotency check, enqueue SQS
      ▼
3. SQS FIFO → Incident Processor
      │ Create DynamoDB incident record (ALERT_RECEIVED)
      │
      ├── [parallel]
      │   ├── Grafana OnCall REST: get on-call user + escalation chain
      │   ├── WorkOS Directory Sync API: get team members → Slack user IDs
      │   ├── Grafana Cloud: Mimir + Loki + Tempo context snapshot
      │   └── GitHub: CODEOWNERS + recent commits
      │
      ▼ (all parallel requests resolve or time out)
4. Create Slack private channel (marshal-p1-{date}-{id})
      │ Audit log: WAR_ROOM_CREATED
      ▼
5. Invite responders (loop with jitter)
      │ Audit log: RESPONDER_INVITED per user
      ▼
6. Post context snapshot to channel
      ▼
7. Post + pin incident checklist
      │ Update DynamoDB: ROOM_ASSEMBLED
      ▼
8. Create EventBridge Scheduler rule (15-min nudge)
      │
      ▼
      DONE — war room assembled
```

---

## 5. Interface Contracts (locked before eng-backend + eng-ai begin)

### 5.1 Grafana OnCall Webhook Payload (incoming)
```typescript
interface GrafanaOnCallAlertPayload {
  alert_group_id: string;        // becomes incident_id
  alert_group: {
    id: string;
    title: string;
    state: 'firing' | 'resolved' | 'silenced';
  };
  integration_id: string;
  route_id: string;
  team_id: string;
  team_name: string;
  labels?: Record<string, string>;
  alerts: Array<{
    id: string;
    title: string;
    message: string;
    image_url?: string;
    source_url?: string;
    received_at: string;         // ISO 8601
  }>;
}
```

### 5.2 Incident State (DynamoDB projected type)
```typescript
type IncidentStatus = 
  | 'ALERT_RECEIVED'
  | 'ROOM_ASSEMBLING'  
  | 'ASSEMBLY_FAILED'
  | 'ROOM_ASSEMBLED'
  | 'ACTIVE'
  | 'MITIGATED'
  | 'RESOLVED';

interface IncidentRecord {
  incident_id: string;
  status: IncidentStatus;
  alert_payload: GrafanaOnCallAlertPayload;
  slack_channel_id?: string;
  slack_channel_name?: string;
  ic_user_id?: string;
  responders: string[];          // Slack user IDs
  context_snapshot?: GrafanaContextSnapshot;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
  ic_rating?: 1 | 2 | 3 | 4 | 5;
  linear_postmortem_id?: string;
}
```

### 5.3 Audit Event Types
```typescript
type AuditEventType = 
  | 'WAR_ROOM_CREATED'
  | 'RESPONDER_INVITED'
  | 'RESPONDER_INVITE_FAILED'
  | 'CONTEXT_SNAPSHOT_ATTACHED'
  | 'CHECKLIST_PINNED'
  | 'STATUS_UPDATE_SENT'          // IC posted a status message
  | 'STATUS_REMINDER_SENT'        // Marshal nudged IC
  | 'STATUS_REMINDER_SILENCED'    // IC silenced reminders
  | 'STATUSPAGE_DRAFT_CREATED'
  | 'STATUSPAGE_DRAFT_APPROVED'   // ← contains SHA256 of draft body
  | 'STATUSPAGE_PUBLISHED'        // ← MUST always follow DRAFT_APPROVED
  | 'POSTMORTEM_CREATED'
  | 'IC_RATED'
  | 'INCIDENT_RESOLVED'
  | 'DIRECTORY_LOOKUP_FAILED'
  | 'ASSEMBLY_FALLBACK_INITIATED';
```

### 5.4 Grafana Cloud Context Snapshot
```typescript
interface GrafanaContextSnapshot {
  queried_at: string;
  error_rate_2h: {
    current: number;             // e.g. 0.15 (15%)
    baseline: number;
    series_url: string;          // Grafana dashboard link
  };
  p99_latency_ms: {
    current: number;
    baseline: number;
  };
  error_budget_burn_rate: number;
  log_excerpts: string[];        // last 10 error lines
  sample_trace_ids: string[];    // up to 5
  datasource_errors?: string[];  // if any Grafana queries failed
}
```

---

## 6. Template Selection Summary

| Component | Template | Rationale |
|-----------|----------|-----------|
| Webhook Lambda | `ts-service` (Lambda) | Stateless ingress, auto-scales |
| Core Processor | `worker-service` | Long-running Slack socket mode + state machine |
| Infrastructure | `infra-aws` | CDK v2, AWS deploy target |
| AI Layer | `module-llm` + `prompt-library` | Bedrock runtime, prompt caching |
| State + Audit | `module-database` | DynamoDB single-table, event-sourced |
| Observability | `module-observability` | CloudWatch structured logs + metrics |
| Secrets | via `infra-aws` | Secrets Manager, IAM task role |

---

## 7. Dependency Graph (for parallel execution)

```
intake-analyst ──► product ──► engineering (this doc)
                                    │
                          ┌─────────┴──────────┐
                          ▼                    ▼
                      eng-infra          eng-backend ∥ eng-ai
                          │                    │
                          └─────────┬──────────┘
                                    ▼
                         qa-security ∥ ops-sre ∥ ops-incident
                                    │
                                    ▼
                                  qa ──► qa-automation
                                    │
                          ┌─────────┼──────────┐
                          ▼         ▼           ▼
                     pr-reviewer  build-   artifact-
                                 verifier   auditor
                                    │
                                    ▼
                             release-manager
```
