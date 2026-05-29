# Marshal — Test Plan
**Author:** qa  
**Version:** 1.0  
**Last Updated:** 2025-01-15

---

## 1. Test Strategy

### Philosophy
Marshal handles real P1 incidents. Bugs have real consequences: missing responders, failed status updates, and — worst of all — auto-published status messages without IC approval. The test strategy is defense-in-depth:

1. **Unit tests** — every service class, every client, every state transition
2. **Integration tests** — approval gate end-to-end; WorkOS Directory Sync fallback; DynamoDB event sourcing
3. **Contract tests** — Grafana OnCall webhook payload schema; Slack Block Kit schemas
4. **Security tests** — approval gate invariant; no-fabricated-invite-list; audit-write-awaited
5. **Performance tests** — war room assembly under load (≤5 min target)

### Coverage Targets
- Line coverage: ≥85%
- Branch coverage: ≥80%
- **`src/services/statuspage-approval-gate.ts`: 100% branch coverage** (security-critical)
- **`src/utils/audit.ts`: 100% branch coverage** (security-critical)

---

## 2. Unit Tests

### 2.1 AuditWriter (src/utils/audit.ts)

| Test ID | Description | Expected |
|---------|-------------|----------|
| AUDIT-001 | `write()` puts item in DynamoDB with correct PK/SK/TTL | Item exists with TTL ≈ now + 366 days |
| AUDIT-002 | `write()` is idempotent (ConditionalCheckFailedException) | No error thrown; second write silently ignored |
| AUDIT-003 | `write()` throws on DynamoDB failure (non-idempotency error) | Error propagates to caller |
| AUDIT-004 | `writeStatuspageApproval()` writes correct SHA256 of draft body | SHA256 in event matches `crypto.createHash('sha256').update(body).digest('hex')` |
| AUDIT-005 | `verifyApprovalBeforePublish()` throws `AutoPublishNotPermittedError` if no approval event | Error thrown; message includes incident_id |
| AUDIT-006 | `verifyApprovalBeforePublish()` uses `ConsistentRead: true` | QueryCommand called with `ConsistentRead: true` |
| AUDIT-007 | `verifyApprovalBeforePublish()` passes when approval event exists | No error thrown |
| AUDIT-008 | `auditApprovalGateViolations()` returns empty array when all published events have approval events | Returns [] |
| AUDIT-009 | `auditApprovalGateViolations()` returns published events that lack approval events | Returns the orphaned published event |

### 2.2 StatuspageApprovalGate (src/services/statuspage-approval-gate.ts)

| Test ID | Description | Expected |
|---------|-------------|----------|
| GATE-001 | `createDraft()` stores draft with PENDING_APPROVAL status | Draft exists in DynamoDB; audit event STATUSPAGE_DRAFT_CREATED written |
| GATE-002 | `approveAndPublish()` — happy path | DynamoDB approval event written → verified → Statuspage called → PUBLISHED event written → draft status PUBLISHED |
| GATE-003 | `approveAndPublish()` — Statuspage API call throws | PUBLISHED event NOT written; draft remains PENDING_APPROVAL; error propagated |
| GATE-004 | `approveAndPublish()` — DynamoDB audit write fails | Statuspage API NEVER called; `AutoPublishNotPermittedError` thrown |
| GATE-005 | `approveAndPublish()` — draft does not exist | Error thrown; Statuspage not called |
| GATE-006 | `approveAndPublish()` — draft is already PUBLISHED | Error thrown; Statuspage not called again |
| GATE-007 | `rejectDraft()` updates draft status to REJECTED and writes audit event | Draft status = REJECTED; STATUSPAGE_APPROVAL_REJECTED audit event written |
| GATE-008 | **No code path can call Statuspage without audit-confirmed approval** | Manual code review + static analysis check for direct `statuspageClient.createIncident()` calls outside the gate |

### 2.3 WarRoomAssembler (src/services/war-room-assembler.ts)

| Test ID | Description | Expected |
|---------|-------------|----------|
| ASSEMBLE-001 | `assemble()` — happy path creates channel, invites responders, posts snapshot + checklist | All 7 assembly steps complete; incident record saved |
| ASSEMBLE-002 | WorkOS Directory Sync failure → no responders invited → fallback error posted to channel | `DIRECTORY_LOOKUP_FAILED` audit event; `ASSEMBLY_FALLBACK_INITIATED` audit event; channel still created; 0 responders |
| ASSEMBLE-003 | Grafana Cloud context query fails → snapshot missing but assembly continues | Warning posted in channel; assembly completes without snapshot |
| ASSEMBLE-004 | Slack channel creation fails → throws; DynamoDB status updated to ASSEMBLY_FAILED | Error propagated; status = ASSEMBLY_FAILED |
| ASSEMBLE-005 | Duplicate `alert_group_id` → idempotency check in Lambda prevents second assembly | Second webhook returns 200 with "Duplicate event ignored" |
| ASSEMBLE-006 | All Slack invite calls succeed; `RESPONDER_INVITED` audit events written for each | N audit events for N responders |
| ASSEMBLE-007 | One Slack invite fails (user left workspace) → `RESPONDER_INVITE_FAILED` audit event | Remaining invites continue; failed one is logged |
| ASSEMBLE-008 | Nudge scheduler failure does not block assembly | Assembly completes; warning logged for scheduler failure |
| ASSEMBLE-009 | Channel name format: `marshal-p1-YYYYMMDD-{shortid}` | Channel name matches regex |
| ASSEMBLE-010 | Audit writes: `WAR_ROOM_CREATED` → `RESPONDER_INVITED` × N → `CONTEXT_SNAPSHOT_ATTACHED` → `CHECKLIST_PINNED` | All events in DynamoDB audit table |

### 2.4 MarshalAI (src/ai/marshal-ai.ts)

| Test ID | Description | Expected |
|---------|-------------|----------|
| AI-001 | `generateStatusDraft()` — Bedrock returns valid response | Stripped draft returned; no customer-identifying patterns |
| AI-002 | `generateStatusDraft()` — Bedrock times out | Safe fallback template returned; no error thrown |
| AI-003 | `generateStatusDraft()` — draft body contains email pattern | Email stripped by guardrail |
| AI-004 | `generateStatusDraft()` — draft body contains account ID `cust-12345` | Account ID stripped |
| AI-005 | `classifyAsStatusUpdate()` — "investigating the issue now" | `{is_status_update: true, confidence: >0.8}` |
| AI-006 | `classifyAsStatusUpdate()` — "ok" | `{is_status_update: false}` |
| AI-007 | `classifyAsStatusUpdate()` — Bedrock fails | `{is_status_update: false, confidence: 0}` |
| AI-008 | `generatePostmortemSections()` — Bedrock fails | Fallback template with [IC to complete] returned |

### 2.5 HttpClient (src/utils/http-client.ts)

| Test ID | Description | Expected |
|---------|-------------|----------|
| HTTP-001 | Request succeeds on first attempt | Single HTTP call; response returned |
| HTTP-002 | First attempt fails with 503; second succeeds | Two HTTP calls; response returned |
| HTTP-003 | Both attempts fail (429 → 429) | Error thrown after 2 attempts |
| HTTP-004 | Request times out at 5s | `ExternalClientTimeoutError` thrown |
| HTTP-005 | `noRetry: true` — first attempt fails | Exactly 1 HTTP call; error thrown |
| HTTP-006 | Timeout is hard-capped at 5000ms | Timeout > 5000 is silently capped; AbortSignal fires at 5s |
| HTTP-007 | Max retries is hard-capped at 2 | `maxRetries: 10` in constructor → actual retries = 2 |

### 2.6 GrafanaOnCallClient

| Test ID | Description | Expected |
|---------|-------------|----------|
| ONCALL-001 | `getEscalationChainForIntegration()` returns chain | Chain object returned |
| ONCALL-002 | `extractEmailsFromChain()` deduplicates emails | Unique emails only |
| ONCALL-003 | 404 from Grafana OnCall API | Returns null (graceful degradation) |

### 2.7 WorkOSClient

| Test ID | Description | Expected |
|---------|-------------|----------|
| WORKOS-001 | `getUsersInGroup()` returns active users | Active users returned; DEPROVISIONED filtered |
| WORKOS-002 | `getUsersInGroup()` — WorkOS Directory Sync 500 — no cache | `DirectoryLookupFailedError` thrown |
| WORKOS-003 | `getUsersInGroup()` — WorkOS Directory Sync 500 — stale cache available | Stale cached users returned; warning logged |
| WORKOS-004 | Cache hit within TTL | No HTTP call; cached data returned |

---

## 3. Integration Tests

### INT-001: Full Approval Gate Flow (Against DynamoDB Local)

**Setup:** DynamoDB local instance; test audit table  
**Steps:**
1. Create a test incident + draft
2. Call `writeStatuspageApproval()`
3. Call `verifyApprovalBeforePublish()`
4. Verify: no error thrown
5. Call `auditApprovalGateViolations()`
6. Verify: returns []

**Pass criteria:** Steps 3 and 5 complete without error; step 6 returns empty array.

### INT-002: Approval Gate Violation Detection

**Setup:** DynamoDB local; manually insert a `STATUSPAGE_PUBLISHED` event WITHOUT a corresponding `STATUSPAGE_DRAFT_APPROVED` event  
**Steps:**
1. Query `auditApprovalGateViolations()`
2. Verify: returns 1 item (the orphaned published event)

**Pass criteria:** Violation detected; 1 item returned.

### INT-003: WorkOS Directory Sync Fallback in WarRoomAssembler

**Setup:** Mock WorkOS Directory Sync client that throws `DirectoryLookupFailedError`; real Slack mock; real DynamoDB local  
**Steps:**
1. Call `warRoomAssembler.assemble()`
2. Verify: channel created
3. Verify: 0 responders
4. Verify: `DIRECTORY_LOOKUP_FAILED` + `ASSEMBLY_FALLBACK_INITIATED` in audit table
5. Verify: error message posted to Slack channel

**Pass criteria:** All 5 verifications pass.

### INT-004: Webhook Ingress Idempotency

**Setup:** Test DynamoDB; test SQS  
**Steps:**
1. Send the same webhook payload twice (same `alert_group_id`)
2. Verify: only 1 SQS message enqueued
3. Verify: only 1 incident record in DynamoDB

**Pass criteria:** No duplicate processing; idempotency confirmed.

---

## 4. Security Tests (Mandatory — Block Merge Gate)

### SEC-001: Auto-Publish Gate (CRITICAL)
Verify that no code path can call Statuspage.io publish without a confirmed `STATUSPAGE_DRAFT_APPROVED` audit event. See qa-security threat model REQ-S1.

### SEC-002: WorkOS Directory Sync Fallback (No Fabricated Lists)
Verify that WorkOS Directory Sync failure results in 0 invited responders and an explicit error message. See qa-security REQ-S2.

### SEC-003: Audit Writes Awaited
ESLint rule `@typescript-eslint/no-floating-promises` must report 0 errors in `src/utils/audit.ts` and `src/services/statuspage-approval-gate.ts`.

### SEC-004: Bedrock Invocation Logging NONE
Integration test (post-deploy): verify `GetModelInvocationLoggingConfiguration` returns NONE.

---

## 5. Performance Tests

### PERF-001: War Room Assembly Under Load
- Simulate 5 simultaneous P1 alerts (different `alert_group_id`)
- Verify: all 5 war rooms assembled within 5 minutes
- Verify: no Slack rate-limit errors (429s)
- Verify: SQS FIFO ordering preserved per incident group

### PERF-002: Bedrock Draft Generation Latency
- 10 sequential status draft requests
- p50 must be ≤10s
- p95 must be ≤15s

---

## 6. Acceptance Criteria Matrix

| Success Metric | Test | Pass Threshold |
|---------------|------|----------------|
| War room assembled ≤5 min | ASSEMBLE-001 + PERF-001 | 100% of drills |
| Responders invited within 3 min | ASSEMBLE-006 | ≥95% |
| 100% approval gate | GATE-003/004 + SEC-001 + Drill audit query | 0 violations |
| WorkOS Directory Sync fallback works | ASSEMBLE-002 + INT-003 + Drill 3 | Must pass |
| Nudge at 15 min | Manual drill observation | ≥95% |
| Postmortem in Linear ≤2 min | Drill 2 measurement | 100% |
| IC rating collected | Drill 2 verification | Must fire |
