# Marshal — Incident Drill Playbook
**Author:** ops-incident  
**Version:** 1.0  
**Purpose:** Tabletop drill and live fire test protocol for Marshal before v1 launch  
**Required:** One tabletop drill + one monitored live-fire drill before launch gate  

---

## Overview

Incident drills validate that:
1. Marshal assembles a war room in ≤5 minutes (success metric)
2. The 100% approval gate is airtight (no test-induced publish without explicit IC approval)
3. The postmortem draft appears in Linear within 2 minutes of resolution
4. IC pulse rating is collected
5. WorkOS Directory Sync fallback path works cleanly
6. Status update nudge fires at 15 minutes and respects silence

---

## Pre-Drill Checklist

Before any drill:

- [ ] Staging environment deployed and healthy (ECS task running, DLQ empty)
- [ ] Test Grafana OnCall integration configured (staging-specific webhook URL)
- [ ] Test Slack workspace (or dedicated `#marshal-drill-*` channels isolated from production)
- [ ] Test Statuspage.io page (staging page, not the production customer-facing page)
- [ ] Test Linear project (separate from production Incidents project)
- [ ] All 14 Secrets Manager entries populated with staging credentials
- [ ] ops-sre monitoring dashboard open in separate window
- [ ] Drill participants briefed: one IC (senior engineer), two simulated responders, one observer (ops-sre), one timekeeper
- [ ] Recording method confirmed (screen recording or designate a scribe)

---

## Drill 1: Tabletop (No Live Systems)

**Duration:** 60 minutes  
**Participants:** IC, ops-sre lead, engineering lead  
**Goal:** Walk through the Marshal ceremony step-by-step; identify gaps in the design before live fire  

### Scenario: "Database Connection Pool Exhausted at 3 AM"

**Narrative:**
At 3:02 AM, the checkout service starts timing out. Grafana OnCall fires a P1 alert (`integration_id: checkout-prod, team: payments-engineering`). The on-call engineer is the IC for this incident.

**Tabletop questions:**
1. *At alert fire (T+0):* Marshal creates the war room. Who gets invited? Walk through the WorkOS Directory Sync group + Grafana OnCall escalation chain resolution. What happens if WorkOS Directory Sync is down?
2. *At T+5:* Context snapshot is posted. The Grafana Cloud metrics show 45% error rate on checkout, p99 latency spiked to 8000ms. Error budget burn rate: 14x. The IC wants a status page draft. How does the IC trigger it? What does the draft say?
3. *At T+12:* The IC is deep in debugging. Marshal nudges at 15 minutes. Walk through the nudge UX. What does the ephemeral message say? Can the IC silence it?
4. *At T+15:* IC approves the status page draft. Walk through the Block Kit approve flow. What audit events are written? What happens if the IC clicks "Approve" but Statuspage.io is down?
5. *At T+45:* Incident resolved. How does the IC trigger resolution? What postmortem draft appears in Linear? Walk through each section.
6. *Post-incident:* IC rates Marshal 4/5. How is this recorded?

**Discussion focus:**
- Does the war room assembly sequence feel right for 3 AM?
- Are the checklist items in the right order?
- Is the Bedrock-drafted status page copy appropriate for customers? What would make it better?
- What's the biggest friction point in the approval flow?

---

## Drill 2: Live Fire — Happy Path

**Duration:** 45 minutes  
**Participants:** IC (designated), 2 responders (designated), ops-sre observer, timekeeper  
**Goal:** Validate that Marshal meets the ≤5-min assembly target and all key flows work  

### Setup

1. Create a test alert payload:
```json
{
  "alert_group_id": "drill-001-happy-path",
  "alert_group": {
    "id": "drill-001-happy-path",
    "title": "DRILL: Checkout Service Degraded",
    "state": "firing"
  },
  "integration_id": "checkout-staging",
  "route_id": "route-staging-payments",
  "team_id": "payments-engineering",
  "team_name": "Payments Engineering",
  "alerts": [{
    "id": "alert-001",
    "title": "DRILL: Checkout Service Degraded",
    "message": "DRILL ONLY — Error rate 45%, p99 latency 8000ms on checkout service",
    "received_at": "<ISO timestamp>"
  }]
}
```

2. Compute HMAC-SHA256 signature using the staging HMAC secret
3. Have the timekeeper ready

### Execution Script

**T+0:00** — ops-sre sends webhook:
```bash
HMAC_SECRET=$(aws secretsmanager get-secret-value --secret-id marshal/grafana/oncall-webhook-hmac --query SecretString --output text --profile staging)
BODY='{"alert_group_id":"drill-001-happy-path",...}'  # full payload
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" | awk '{print $2}')
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Grafana-OnCall-Signature: $SIGNATURE" \
  -d "$BODY" \
  <staging-webhook-url>/webhook/grafana-oncall
```

**Checkpoints (timekeeper records each timestamp):**

| Checkpoint | Expected | Actual | Pass? |
|-----------|----------|--------|-------|
| Slack channel created | T+0:00 to T+0:30 | | |
| First responder invited | T+0:00 to T+3:00 | | |
| Both responders invited | T+0:00 to T+3:30 | | |
| Context snapshot posted | T+0:00 to T+1:00 | | |
| Checklist pinned | T+0:00 to T+1:30 | | |
| **War room assembled (all responders in)** | **T+0:00 to T+5:00** | | |

**At T+5:00** — IC runs `/marshal status draft`
- Expected: Approval message appears with draft body
- Verify: Draft body contains no customer names, email addresses, account IDs
- IC clicks "✅ Approve & Publish"
- Expected: Statuspage.io staging incident created; confirmation in channel
- ops-sre verifies: audit event `STATUSPAGE_DRAFT_APPROVED` exists in DynamoDB
- ops-sre verifies: audit event `STATUSPAGE_PUBLISHED` exists in DynamoDB

**At T+15:00** — ops-sre monitors for nudge
- Expected: IC receives ephemeral nudge (visible only to IC)
- Verify: IC sees the nudge; it does not appear to other participants

**At T+20:00** — IC runs `/marshal resolve`
- Expected: Pulse rating appears (ephemeral to IC)
- IC rates 4/5
- Expected: `IC_RATED` audit event in DynamoDB within 30 seconds

**At T+21:00** — ops-sre verifies Linear postmortem draft
- Expected: Issue created in staging Incidents project
- Title: `[P1 Postmortem] DRILL: Checkout Service Degraded — <date>`
- All timeline events from the drill should appear
- Sections: Summary, Timeline, Participants, Metrics, Recent Changes

**Final gate check (ops-sre):**
```bash
# This query must return 0 rows — ALWAYS
aws dynamodb query \
  --table-name marshal-audit-staging \
  --index-name published-without-approval-index \
  --key-condition-expression "action_type = :at" \
  --expression-attribute-values '{":at":{"S":"STATUSPAGE_PUBLISHED"}}' \
  --output json | jq '[.Items[] | select(.approved_event_exists != true)] | length'
# Expected output: 0
```

---

## Drill 3: Live Fire — WorkOS Directory Sync Failure Path

**Duration:** 20 minutes  
**Goal:** Validate that Marshal gracefully handles WorkOS Directory Sync failure and surfaces clear error to IC  

### Setup

1. Temporarily invalidate the staging WorkOS API key (change one character in Secrets Manager)
2. Fire the same test webhook as Drill 2 (different `alert_group_id`)

### Checkpoints

| Checkpoint | Expected | Pass? |
|-----------|----------|-------|
| Slack channel created | Yes | |
| Error message posted to channel | "⚠️ Responder auto-invite failed..." | |
| Audit event `DIRECTORY_LOOKUP_FAILED` in DynamoDB | Yes | |
| Audit event `ASSEMBLY_FALLBACK_INITIATED` in DynamoDB | Yes | |
| No responders auto-invited | Responder count = 0 | |
| IC can manually invite via `/marshal invite @user` | Yes | |

### Cleanup
Restore the staging WorkOS API key.

---

## Drill 4: Silence Path

**Duration:** 15 minutes  
**Goal:** Validate that IC silencing reminders is audit-logged and honoured  

### Checkpoints

| Checkpoint | Expected | Pass? |
|-----------|----------|-------|
| IC clicks "Silence reminders" button | No more nudges for this incident | |
| Audit event `STATUS_REMINDER_SILENCED` with IC user_id + timestamp | Yes | |
| Postmortem timeline shows silencing event | Yes | |

---

## Drill Pass/Fail Criteria

All of the following must pass before v1 launch:

| Criterion | Target |
|-----------|--------|
| War room assembled in Drill 2 | ≤5:00 |
| All responders invited in Drill 2 | ≤3:00 |
| Approval gate query returns 0 | Must be 0 |
| Postmortem created in Drill 2 | ≤2:00 after resolve |
| WorkOS Directory Sync error visible to IC in Drill 3 | Within 30s |
| Silencing audit-logged in Drill 4 | Must be present |

---

## Post-Drill Debrief Template

After each drill, complete:

**Date:**  
**IC name:**  
**Drill type:** [Tabletop / Live Fire Happy Path / WorkOS Directory Sync Failure / Silence]  

**What went well:**

**What broke or was slow:**

**Timing measurements:**
- T+0 to war room assembled: ___
- T+0 to first responder invited: ___
- T+0 to context snapshot posted: ___

**IC feedback on Marshal helpfulness (1-5):**

**Action items before next drill:**

---

## Escalation

If any live-fire drill reveals a broken approval gate (audit query returns > 0), immediately:
1. Take staging offline
2. File P0 bug in Linear with qa-security label
3. Do NOT proceed with production deployment until the gate is verified in a fresh drill
