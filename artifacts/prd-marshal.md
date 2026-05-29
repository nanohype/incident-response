# Product Requirements Document — Marshal
**Version:** 1.0  
**Status:** APPROVED FOR BUILD  
**Author:** product  
**Last Updated:** 2025-01-15  

---

## 1. Problem Statement

When a P1 fires at a 500-person mid-enterprise SaaS, the first 15–20 minutes are chaos. The on-call engineer pages people from memory (often wrong ones), Slack war rooms get created ad-hoc with missing responders, the IC forgets to send status updates while heads-down debugging, customer-facing communication lags or goes out with wrong detail, and post-resolution nobody writes the postmortem because everyone is exhausted.

Incident response is a ceremony. Every mid-enterprise org knows the ceremony. Almost none of them execute it cleanly at 3 AM under pressure.

**Marshal is a ceremonial assistant for incident commanders.** It handles the ceremony so the IC can focus on resolving the incident.

---

## 2. Goals & Success Metrics

### Primary OKRs — v1 (4 weeks)

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Median P1 alert → war room assembled | ~20 min | ≤5 min | Grafana OnCall webhook timestamp → last Slack `member_joined` event timestamp |
| On-call responder invited within 3 min | unmeasured | ≥95% of P1s | Slack `member_joined` timestamp vs. war-room creation timestamp |
| IC pulse rating "Marshal helped me think clearly" | n/a | ≥4/5 over rolling 10 incidents | Slack ephemeral emoji-rating at incident resolution |
| Status-update cadence (median gap) | unmeasured | ≤15 min; bot nudge responsible for ≥60% of on-time updates | Slack message timestamps in war-room channel |
| Marshal-drafted status messages published without IC approval | n/a | **0** (100% gate) | Audit log query: `published_messages` WHERE `approved = false` |

### Sustained Performance OKRs — v2 (8 weeks from kick-off)

| Metric | Target |
|--------|--------|
| ≥95% of P1s close with postmortem draft in Linear within 48h | Measured by Linear issue `created_at` vs. incident `resolved_at` |
| 100% approval gate maintained at scale (≥10 real incidents) | Audit log query at 30-day window |

---

## 3. User Personas

### Primary: Incident Commander (IC)
- Senior engineer in a rotating on-call role
- Under significant cognitive load during P1; needs to triage, direct responders, communicate with stakeholders simultaneously
- Wants a co-pilot that reduces coordination overhead, not a chatbot to argue with
- Will rate Marshal 1-5 at resolution; low scores are a direct signal of bad behavior

### Secondary: On-Call Responders
- Receive Slack invite and context snapshot without doing anything
- Main frustration today: no context on why they were paged
- Want: immediate context (what broke, what the error rate looks like, what deployed recently)

### Tertiary: Engineering Leadership / SRE
- Read the war room in flight; need accurate status updates without asking
- Post-resolution: read the postmortem to understand what happened

### Quaternary: Customer Success + PR
- Receive draft status-page copy for review and approval
- Never touch the raw Statuspage.io API
- Must approve before anything reaches customers

---

## 4. Feature Specification

### 4.1 War Room Assembly (P1 Trigger → Room Open)

**Trigger:** Grafana OnCall webhook fires to Marshal's ingress endpoint with a P1 alert payload containing `integration_id`, `route_id`, `team assignment`, and `alert_group_id` (used as `incident_id`).

**Assembly sequence (target: ≤5 min end-to-end):**

1. **Parse alert** — extract integration_id, route_id, team, alert_group_id; create incident record in DynamoDB
2. **Query on-call rotation** — Grafana OnCall REST API: `GET /api/v1/escalation_chains/?integration_id=` → get the current on-call user and escalation chain
3. **Resolve responders** — WorkOS Directory Sync API: fetch group membership for the team associated with the route; cross-reference with Grafana OnCall escalation chain; deduplicate; look up Slack user IDs via Slack `users.lookupByEmail`
   - If WorkOS Directory Sync fails: surface explicit error to IC in direct message, prompt IC to manually invite; do NOT fabricate a list
4. **Query Grafana Cloud context** — parallel requests to Mimir (error rate last 2h), Loki (log excerpts, last 50 error lines), Tempo (sample trace IDs); 5s timeout per request; assemble context snapshot
5. **Query CODEOWNERS + deploy timeline** — GitHub API: `GET /repos/{owner}/{repo}/contents/CODEOWNERS` for the service matching the alert's team tag; `GET /repos/{owner}/{repo}/commits` last 5 commits in last 4h
6. **Create Slack war room** — `conversations.create` (private channel, name: `marshal-p1-{YYYYMMDD}-{short_incident_id}`)
7. **Invite responders** — `conversations.invite` loop with retry-with-jitter; await all invites
8. **Pin incident checklist** — post checklist message + pin it; checklist is the running task tracker for the incident lifecycle
9. **Post context snapshot** — formatted Slack message with: alert details, error rate chart link, p99 latency, error-budget burn, recent log excerpts, sample trace IDs, CODEOWNERS, recent deploys
10. **Audit log** — write war-room-create event with all participant user IDs, timestamps, Grafana alert payload; await write

**War room name format:** `marshal-p1-{YYYYMMDD}-{short-id}` (e.g., `marshal-p1-20250115-abc1`)

**Incident checklist (pinned, v1):**
- [ ] War room assembled
- [ ] IC confirmed
- [ ] Responders joined
- [ ] Initial severity assessed
- [ ] Customer impact identified
- [ ] Status page draft created
- [ ] Status page approved and published
- [ ] Incident mitigated
- [ ] All-clear confirmed
- [ ] Postmortem draft created
- [ ] Postmortem reviewed and published

### 4.2 Status Update Cadence (Running the Incident)

**Nudge timer:** Marshal starts a 15-minute countdown after war-room creation. If no status update is posted by the IC in the war-room within 15 minutes, Marshal posts an ephemeral reminder to the IC only (not the full channel).

**Nudge format (ephemeral):**
> 🕒 **15-minute status update due.** No update posted since {HH:MM}. Post a quick status so the room is current, or click Silence to pause reminders for this incident.

**Silence handling:**
- IC clicks "Silence reminders" → reminders paused for remainder of incident
- Silencing event is audit-logged with IC's user_id, timestamp, incident_id
- On postmortem draft, the silencing event is included in the timeline with note "IC silenced status reminders at {time}"

**Status update detection:** Marshal watches for any message by the IC user_id in the war-room channel and resets the 15-minute timer on each IC message. (Non-IC messages do not reset the timer.)

**Rate limit:** Maximum 1 nudge per 5-minute window per incident. If IC has not responded within 30 minutes of the last nudge, Marshal escalates by DM-ing the secondary on-call (if defined in Grafana OnCall escalation chain) with a note that the IC has not posted updates.

### 4.3 Status Page Draft → Approve → Publish Flow

**Draft creation trigger:** IC types `/marshal status draft` OR Marshal auto-proposes a draft when checklist item "Status page draft created" becomes due (after 15 minutes if no draft exists).

**Draft composition:**
- Bedrock claude-sonnet-4-6 with prompt caching
- Input: alert title, affected service, Grafana error rate, IC's most recent war-room message (optional context)
- Template: generic phrasing only — "some customers", "a subset of requests", "certain features"
- No customer names, no account IDs, no internal system names in draft
- Draft is stored in DynamoDB with SHA256 hash of draft body and status `PENDING_APPROVAL`

**Approval flow (Slack Block Kit interactive message):**
- Marshal posts the draft to the war-room as a formatted message with two buttons: **✅ Approve & Publish** and **✏️ Edit Draft**
- "Approve & Publish": 
  1. Records approval event in audit log: `{user_id, timestamp, SHA256(draft_body), incident_id, event: "STATUSPAGE_APPROVED"}`; **awaits the DynamoDB write**
  2. Only after confirmed audit-log write: calls Statuspage.io `POST /v1/pages/{page_id}/incidents` API
  3. Updates checklist: "Status page approved and published ✅"
  4. Posts confirmation in war-room: "Status page updated by @{IC_name} at {time}"
- "Edit Draft": opens Slack modal with the draft text pre-populated; IC edits and submits; re-generates a new draft with IC's edits incorporated; new draft goes back through approval flow

**Hard invariant:** The `STATUSPAGE_APPROVED` DynamoDB event record MUST exist and be confirmed before the Statuspage.io publish call is made. The publish function checks for this record at runtime; if not found (e.g., function called outside normal flow), it throws `AutoPublishNotPermitted` and alerts the engineering on-call. This is not configurable. There is no "auto-publish after N minutes" escape hatch. There is no "silent mode" that bypasses this check.

**Audit query for success verification:**
```
SELECT * FROM audit_log 
WHERE event_type = 'STATUSPAGE_PUBLISHED' 
AND approved_at IS NULL
```
This query must always return 0 rows. This is the 100% approval-gate metric.

### 4.4 IC Pulse Rating (Resolution)

**Trigger:** IC runs `/marshal resolve` OR Grafana OnCall sends `alert_group_resolved` webhook.

**Sequence:**
1. Marshal updates incident status to `RESOLVED` in DynamoDB
2. Posts ephemeral message to IC only:
   > 🎉 Incident resolved. How well did Marshal help you think clearly?
   > [⭐] [⭐⭐] [⭐⭐⭐] [⭐⭐⭐⭐] [⭐⭐⭐⭐⭐]
3. IC clicks a rating → stored in DynamoDB: `{incident_id, user_id, rating, timestamp}`
4. Rating does not affect postmortem creation (which proceeds regardless)
5. Rolling 10-incident window computed by `data-analyst` dashboard reading from DynamoDB

**If IC does not rate within 24h:** Marshal sends one follow-up DM. If still no rating after 48h, incident is marked `RATING_SKIPPED` — not counted in rolling average.

### 4.5 Postmortem Draft (Linear)

**Trigger:** Incident resolved (either via webhook or `/marshal resolve`).

**Target SLA:** Postmortem draft created in Linear within 2 minutes of resolution; 48h SLA is the IC's deadline to author the analysis section.

**Draft composition:**
- Bedrock claude-sonnet-4-6 with prompt caching
- Pre-populated sections:
  - **Incident title** — from alert title
  - **Incident ID / War room** — incident_id + Slack channel link
  - **Severity** — P1
  - **Timeline** — reconstructed from DynamoDB event stream (alert fire, war-room created, each status-update timestamp, IC messages, approval events, resolution event)
  - **Participants** — all war-room members with their roles
  - **Metrics at incident time** — error rate, p99 latency, error-budget burn (from Grafana Cloud snapshot)
  - **Recent deploys** — from GitHub CODEOWNERS + commits query
  - **Status page updates** — all approved-and-published messages with timestamps
  - **IC pulse rating** — if provided
  - **Root cause analysis** — `[IC to complete]` placeholder
  - **Action items** — `[IC to complete]` placeholder
  - **What went well** — `[IC to complete]` placeholder

**Linear integration:**
- Creates issue in `Incidents` project (configurable Linear project ID per install)
- Title format: `[P1 Postmortem] {alert_title} — {YYYY-MM-DD}`
- Assigns to IC
- Labels: `postmortem`, `p1`
- Includes link back to Slack war-room
- Status: `In Progress` (IC must mark `Complete` when analysis is done)

**48h SLA monitoring:** A DynamoDB TTL-triggered Lambda (or EventBridge rule) fires at 48h post-resolution; if Linear issue is still `In Progress`, it sends a DM to the IC and CC's the engineering manager (configurable).

---

## 5. Slash Commands

| Command | Description | Who can run |
|---------|-------------|-------------|
| `/marshal status` | Show current incident status summary | Any war-room member |
| `/marshal status draft` | Trigger Bedrock status page draft | IC only |
| `/marshal resolve` | Manually trigger incident resolution | IC only |
| `/marshal checklist` | Re-post the incident checklist | IC only |
| `/marshal invite @user` | Manually invite an additional responder | IC only |
| `/marshal silence` | Silence status-update nudges for this incident | IC only |
| `/marshal help` | Show available commands | Any war-room member |

---

## 6. Non-Functional Requirements

### Performance
- War room assembled (P1 alert → last responder invited): median ≤3 min; p95 ≤5 min
- Grafana Cloud context snapshot attached to war room: ≤30s after channel creation
- Status page draft generated by Bedrock: ≤10s
- Postmortem draft created in Linear: ≤2 min after resolution event

### Reliability
- Marshal webhook ingress: 99.9% uptime (Lambda-backed, auto-scaling)
- War room assembly: idempotent — re-processing the same alert_group_id must not create duplicate war rooms
- All external client calls: timeout ≤5s, retry-with-jitter 2 attempts max; fast-fail preferred

### Security (non-negotiable)
- Status page approval gate: 100% enforcement, verified by audit
- WorkOS Directory Sync fallback: explicit error surfaced to IC, no fabricated invite lists
- Audit log: all actions awaited, 1-year retention, PITR enabled
- Bedrock invocation logging: NONE (CDK-configured)
- Slack bot token: no workspace-admin scope
- Grafana Cloud tokens: read-only scoped per tenant

### Privacy
- Status page drafts: no customer-identifying detail in default templates
- War-room channels: private-by-default; read access to engineering only after resolution + IC handoff
- Audit log: contains user_ids (internal), no customer PII

---

## 7. Out of Scope (v1)

1. Incident detection/alerting — Marshal consumes Grafana OnCall alerts, never generates or modifies them
2. Automatic remediation — Marshal is communication/coordination only; no write access to production systems
3. Multi-org multi-tenancy — single-org install; federation is v2
4. Non-English incidents — English-only v1
5. Auto-publishing status updates — the approval gate is mandatory, no exception modes, no configurable bypass
6. Postmortem root-cause analysis — IC authors the analysis; Marshal provides the populated template
7. Alternative on-call platforms (PagerDuty, Opsgenie, incident.io) — Grafana OnCall only in v1
8. Alternative issue trackers (Jira, GitHub Issues) — Linear only in v1
9. Alternative status pages (Better Stack, custom) — Statuspage.io only in v1
10. Writing to Grafana Cloud — read-only access always

---

## 8. Open Questions (Resolved by Intake Analyst)

| Question | Resolution |
|----------|------------|
| Pulse rating collection UX | Slack ephemeral emoji-rating at resolution; stored in DynamoDB |
| Statuspage.io component selection | IC selects affected components from multi-select at war-room creation or from `/marshal status draft` prompt |
| WorkOS Directory Sync SCIM vs. Groups API | Use WorkOS Directory Sync REST API (`/api/v1/groups/{groupId}/users`), not SCIM endpoint |
| Resolution trigger contract | Grafana OnCall `alert_group_resolved` webhook OR IC `/marshal resolve`; postmortem created within 2 min |

---

## 9. Launch Criteria (v1)

- [ ] All 6 success metrics baseline-captured from v1 test incidents
- [ ] Security audit by qa-security complete with no CRITICAL findings unresolved
- [ ] 100% approval-gate test: integration test proves no code path can publish without `STATUSPAGE_APPROVED` DynamoDB event
- [ ] Runbook complete and reviewed by SRE
- [ ] Incident drill playbook complete and one tabletop drill conducted
- [ ] README enables cold-start onboarding in < 30 minutes
- [ ] Postmortem SLA monitoring Lambda/EventBridge rule verified in staging
