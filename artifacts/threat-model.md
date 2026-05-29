# Marshal — Security Threat Model & Audit
**Author:** qa-security  
**Date:** 2025-01-15  
**Scope:** v1 — Grafana OnCall + Slack + Statuspage.io + Bedrock + DynamoDB  

---

## 1. Threat Model Summary

Marshal is a high-trust incident-response bot with access to: Slack workspace (private channel creation + invite), Statuspage.io (incident creation = customer impact), Linear (issue creation), DynamoDB (audit log), Bedrock (LLM inference), and read access to Grafana Cloud, GitHub, and WorkOS Directory Sync.

The most catastrophic threat is unauthorized status page publication. The second most critical is war-room data exfiltration (P1 war rooms contain live debug data, error logs, trace IDs). Third is audit log tampering (the audit log is the ground-truth record of all incident actions).

---

## 2. STRIDE Threat Analysis

### Spoofing

| Threat | Impact | Control | Status |
|--------|--------|---------|--------|
| Attacker replays Grafana OnCall webhook | Creates duplicate war rooms | HMAC-SHA256 signature + idempotency check (alert_group_id) | ✅ Mitigated |
| Attacker spoofs IC Slack identity | Could approve status page as wrong user | Slack's own auth; Marshal reads user_id from Slack API response, never from message text | ✅ Mitigated |
| Attacker forges Slack interactive message payload | Could trigger fake approval | Slack signing secret verified on every interactive message callback | ✅ Mitigated |
| Bedrock prompt injection via alert payload | Attacker crafts alert title to manipulate LLM output | Alert payload passed as structured data in user-turn; output always shown to IC before action; guardrail strips identifying patterns | ✅ Mitigated |

### Tampering

| Threat | Impact | Control | Status |
|--------|--------|---------|--------|
| Attacker modifies DynamoDB audit record | Destroys ground-truth incident record | IAM: only Marshal's ECS task role can write to audit table; DynamoDB PITR + no-overwrite ConditionExpression | ✅ Mitigated |
| Race condition allows publish before audit write | 100% approval gate violated | `verifyApprovalBeforePublish()` reads from DynamoDB after audit write; both ops must complete atomically | ⚠️ Review (see RISK-AUDIT-1) |
| Attacker modifies Grafana Cloud queries | Returns false context data | Read-only token; Marshal cannot modify Grafana; context shown to IC before action | ✅ Mitigated |

### Repudiation

| Threat | Impact | Control | Status |
|--------|--------|---------|--------|
| IC denies approving status page | Unable to verify approval chain | STATUSPAGE_DRAFT_APPROVED event with user_id + timestamp + SHA256 is always awaited and logged | ✅ Mitigated |
| Engineer denies being paged | Unable to verify who was in the room | RESPONDER_INVITED events with user_id + email in audit log | ✅ Mitigated |
| IC denies silencing reminders | Unable to verify gap in status updates | STATUS_REMINDER_SILENCED event audit-logged with user_id + timestamp | ✅ Mitigated |

### Information Disclosure

| Threat | Impact | Control | Status |
|--------|--------|---------|--------|
| Status page draft leaks customer names | Privacy violation | Guardrail: regex patterns strip email, account IDs, internal hostnames from draft before IC sees it | ✅ Mitigated |
| War room channel visible to unauthorized users | P1 debug data exposed | Channel private-by-default; only invited responders + Marshal bot; no workspace-admin scope | ✅ Mitigated |
| Bedrock prompt/response logged | LLM data in AWS logs | `PutModelInvocationLoggingConfiguration` set to NONE in CDK stack | ✅ Mitigated |
| Grafana Cloud API token exposed in logs | Attacker gains read access to metrics/logs/traces | Tokens in Secrets Manager; never logged; structured logger excludes sensitive env vars | ✅ Mitigated |
| Audit log leaks PII | Privacy violation | Audit log contains Slack user IDs (internal), not customer PII; DynamoDB access restricted to task role | ✅ Mitigated |

### Denial of Service

| Threat | Impact | Control | Status |
|--------|--------|---------|--------|
| Grafana OnCall floods webhook endpoint | Lambda invocations spike; incident processing delayed | SQS FIFO rate-limits processing; FIFO queue per-group ordering prevents race; API Gateway throttle configurable | ✅ Partial (configure API GW throttle) |
| Slack rate limits war-room invite loop | Responders not invited in time | Per-call timeout + retry-with-jitter; instrument Slack API call latency; alert if Slack rate-limited | ⚠️ Monitor |
| EventBridge Scheduler limit (10K schedules default) | Nudges fail for incidents > limit | At 10 P1s/month, this is far from limit; auto-delete on resolve | ✅ Low risk |
| DynamoDB write capacity exhaustion | Audit writes fail | On-demand billing; auto-scales; PITR enabled | ✅ Mitigated |

### Elevation of Privilege

| Threat | Impact | Control | Status |
|--------|--------|---------|--------|
| Marshal bot gains workspace-admin scope | Full workspace access | Slack manifest declares only: chat:write, channels:manage, channels:read, groups:read, groups:write, users:read — no admin scopes | ✅ Mitigated |
| ECS task role gains production-system write access | Marshal could modify production | Explicit DENY policy on EC2/RDS/S3-write/EKS/Lambda mutations | ✅ Mitigated |
| Statuspage.io API key used for unauthorized publish | Customer-facing message without approval | API key only accessible to ECS task role; all publish calls go through approval gate; auto-publish code path does not exist | ✅ Mitigated |
| WorkOS API key used for group modification | Unauthorized group membership changes | WorkOS Directory Sync token has read-only scope (Groups.Read); no write operations in WorkOSClient | ✅ Mitigated |

---

## 3. Critical Security Requirements Verification

### REQ-S1: 100% Status Page Approval Gate

**Verification test (required in qa-automation):**
```typescript
it('should throw AutoPublishNotPermittedError if no approval event in audit log', async () => {
  // Given: an incident with NO STATUSPAGE_DRAFT_APPROVED event
  // When: StatuspageApprovalGate.approveAndPublish() is called
  //   but the HMAC of a forge attempt tries to skip step 2
  // Then: verifyApprovalBeforePublish() reads DynamoDB and finds no event → throws
  
  // The guard in verifyApprovalBeforePublish() is called AFTER writeStatuspageApproval()
  // so normal flow always writes first. The test should mock the DynamoDB client
  // to return 0 items from the approval event query to simulate a missed write.
  
  const gate = new StatuspageApprovalGate(mockDynamo, tableName, auditWriter, mockStatuspage);
  mockAuditWriter.verifyApprovalBeforePublish.mockRejectedValue(new AutoPublishNotPermittedError(incidentId));
  
  await expect(gate.approveAndPublish(incidentId, draftId, userId))
    .rejects.toThrow(AutoPublishNotPermittedError);
  
  expect(mockStatuspage.createIncident).not.toHaveBeenCalled();
});
```

**Additional test:** 
```typescript
it('should NEVER call Statuspage.io if audit write fails', async () => {
  mockDynamo.send.mockRejectedValue(new Error('DynamoDB unavailable'));
  await expect(gate.approveAndPublish(incidentId, draftId, userId))
    .rejects.toThrow();
  expect(mockStatuspage.createIncident).not.toHaveBeenCalled();
});
```

### REQ-S2: WorkOS Directory Sync Fallback (No Fabricated Lists)

**Verification test:**
```typescript
it('should surface DirectoryLookupFailedError and NOT generate invite list on WorkOS Directory Sync failure', async () => {
  mockWorkOSClient.getUsersInGroup.mockRejectedValue(new DirectoryLookupFailedError('WorkOS Directory Sync unavailable'));
  
  const result = await warRoomAssembler.assemble(alertPayload);
  
  // War room should still be created
  expect(result.slack_channel_id).toBeDefined();
  
  // No responders should be invited
  expect(result.responders).toHaveLength(0);
  
  // Audit log should have DIRECTORY_LOOKUP_FAILED and ASSEMBLY_FALLBACK_INITIATED events
  expect(mockAuditWriter.write).toHaveBeenCalledWith(
    expect.anything(),
    'MARSHAL',
    'DIRECTORY_LOOKUP_FAILED',
    expect.any(Object)
  );
});
```

### REQ-S3: Audit Writes Awaited

All audit writes use `await this.auditWriter.write(...)`. Static analysis rule: no `this.auditWriter.write(` without `await` or explicit Promise chaining. Add eslint rule: `@typescript-eslint/no-floating-promises`.

### REQ-S4: Bedrock Invocation Logging

Verified at CDK deploy time by `BedrockLoggingNone` custom resource. Runtime assertion in integration test:
```typescript
it('should verify Bedrock invocation logging is NONE after deploy', async () => {
  const bedrock = new BedrockClient({ region: process.env.AWS_REGION });
  const config = await bedrock.send(new GetModelInvocationLoggingConfigurationCommand({}));
  
  expect(config.loggingConfig?.textDataDeliveryEnabled).toBe(false);
  expect(config.loggingConfig?.imageDataDeliveryEnabled).toBe(false);
});
```

### REQ-S5: Slack Bot Token Scope Enforcement

Slack app manifest lock checked in scaffold-validator. No workspace-admin scope should appear in the manifest.

---

## 4. OWASP Top 10 Coverage

| OWASP | Risk | Marshal Implementation |
|-------|------|------------------------|
| A01 Broken Access Control | War room private channels | Private-by-default; WorkOS-based invite; unlock only post-resolution |
| A02 Cryptographic Failures | Webhook HMAC, token storage | HMAC-SHA256 for webhooks; tokens in Secrets Manager, never in code/logs |
| A03 Injection | Prompt injection via alert data | Structured prompt construction; alert title treated as data, not instructions; IC reviews before action |
| A04 Insecure Design | Auto-publish escape hatch | Hard architectural decision: no auto-publish code path exists; AutoPublishNotPermittedError is not catchable-and-continue |
| A05 Security Misconfiguration | Bedrock logging, IAM roles | Bedrock NONE set at deploy; IAM deny for production systems; explicit scope list for Slack bot |
| A06 Vulnerable Components | npm dependencies | Dependabot enabled; `npm audit` in CI; pin exact versions for security-critical deps |
| A07 Auth Failures | Token rotation | Secrets Manager rotation policies; separate OnCall/Cloud tokens with different rotation cadences |
| A08 Data Integrity Failures | Status page draft tampering | SHA256 of draft body in audit log; body comparison before publish |
| A09 Logging Failures | Audit log fire-and-forget | All audit writes awaited; `@typescript-eslint/no-floating-promises` enforced |
| A10 SSRF | Outbound HTTP from ECS | Only allowlisted external domains per IAM (where applicable); user-controlled URLs not followed |

---

## 5. Dependency Scan Requirements

CI must run:
```bash
npm audit --audit-level=high
```

Any HIGH or CRITICAL finding blocks the merge gate. Exemptions require qa-security approval and Linear ticket.

---

## 6. Open Risks

### RISK-AUDIT-1: DynamoDB Write + Verify Not Atomic [MEDIUM]
The approval flow writes the `STATUSPAGE_DRAFT_APPROVED` event, then immediately reads it back to verify. Under extreme DynamoDB eventual consistency conditions (highly unlikely for PutItem followed by GetItem in the same process), the read could miss the write.

**Mitigation:** Use `ConsistentRead: true` in `verifyApprovalBeforePublish()` Query operation. This ensures the read is strongly consistent.

**Action:** eng-backend must add `ConsistentRead: true` to the QueryCommand in `audit.ts:verifyApprovalBeforePublish()`.

### RISK-AUDIT-2: WorkOS Directory Cache Stale During Security Events [LOW]
If an engineer is offboarded from WorkOS Directory Sync during an active incident, the 5-minute cache could still include them in war-room invites.

**Mitigation:** Acceptable for v1 — 5-minute window is narrow and the IAM permissions are the authoritative access control for production systems. A future improvement is webhook-based cache invalidation from WorkOS Directory Sync.

---

## 7. GATE_VERDICT

GATE_VERDICT: REQUEST_CHANGES

Required before merge:
1. Add `ConsistentRead: true` to `verifyApprovalBeforePublish()` DynamoDB query (RISK-AUDIT-1)
2. Add `@typescript-eslint/no-floating-promises` to ESLint config
3. Confirm Slack app manifest scope lock is validated in CI (scaffold-validator)
4. Integration test for approval gate: `STATUSPAGE_PUBLISHED` without `STATUSPAGE_DRAFT_APPROVED` must return zero rows

These are blocking security requirements, not cosmetic.
