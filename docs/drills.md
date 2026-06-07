# Seeing IncidentResponse work: drills + observability

IncidentResponse is a P1 incident orchestrator. You can't just wait for a real P1 to know it's working — you have to exercise it deliberately. This doc covers five strategies, from cheapest to most realistic, and the scripted drill harness that covers the first of them.

The **drill harness** (`scripts/fire-drill.sh` + `scripts/observe-incident.sh`) is the fastest way to see the whole system move. After staging is deployed and every secret is seeded:

```bash
npm run drill:staging         # fires a synthetic P1 via HMAC-signed webhook
npm run observe:staging       # snapshots the most recent incident's state
```

That gets you through strategies 1 + parts of 3 in under a minute.

## Where to look while the system runs

Five surfaces, each with something different:

| Surface | What you see | How to reach it |
|---|---|---|
| **Slack** | War room channel (`incident-response-p1-YYYYMMDD-<6char>`), pinned checklist, context snapshot, responder invites, `/incident-response` slash commands | Your workspace — check the channel list for recent private channels |
| **Pod logs** | Processor stderr (app-level events, trace-correlated) | `kubectl -n tenants-protohype logs deploy/incident-response-processor -f` |
| **DynamoDB** | Incident state (`ALERT_RECEIVED → ROOM_ASSEMBLING → ROOM_ASSEMBLED → RESOLVED`), full audit trail | `incident-response-staging-incidents` + `incident-response-staging-audit` tables, or via `scripts/observe-incident.sh` |
| **SQS** | In-flight events + DLQ depth (must stay 0) | `incident-response-staging-incident-events.fifo`, `incident-response-staging-nudge-events`, `incident-response-staging-sla-check-events`, plus the DLQ |
| **Grafana / Mimir** | Pod health, CPU/memory, restarts, the three SLO panels | Grafana Cloud → the auto-imported `incident-response` dashboard; or `kubectl -n tenants-protohype get pods` for liveness |

The drill harness synthesises the first three into a single command flow. Pod metrics + traces land in Grafana Cloud via the cluster OTel Collector; pod logs land in Loki via the cluster log forwarder.

## Strategies in order of effort

### 1. HMAC-signed synthetic webhook *(the harness)*

The cheapest way to exercise the full P1 path. `scripts/fire-drill.sh`:

1. Resolves the webhook ingress hostname for the env (the cert-manager-issued ingress host).
2. Reads the HMAC secret from `incident-response/{env}/grafana/oncall-webhook-hmac`.
3. Builds a payload that passes the webhook handler's Zod schema.
4. Signs with HMAC-SHA256 (hex) under header `x-grafana-oncall-signature`.
5. POSTs to `https://<ingress-host>/webhook/grafana-oncall`.
6. Tells you the incident ID + what to watch next.

```bash
# Fire a synthetic P1.
npm run drill:staging
# Output includes:
#   [drill] incident_id=drill-1776567890-12345
#   [drill] HTTP 200
#   [drill] accepted — webhook ingress queued the event to SQS
#   ...

# Snapshot its state a few seconds later.
npm run observe:staging
#   (prints the DDB incident row, full audit trail, queue depths)

# When done:
bash scripts/fire-drill.sh --env staging --state resolved --incident-id drill-1776567890-12345
```

What this tests, in order:

- Webhook Deployment: HMAC verify, Zod validate, idempotency write, SQS enqueue
- SQS FIFO delivery to the processor
- Processor: event registry dispatch to `WarRoomAssembler`
- Slack: private-channel create, context-snapshot post, checklist pin
- WorkOS directory lookup (fails gracefully — `team_id` doesn't exist in the directory)
- Grafana OnCall escalation-chain lookup (fails gracefully — `integration_id` doesn't exist)
- EventBridge Scheduler: 15-min nudge scheduled
- DynamoDB: incident row + full audit trail
- Metrics: `assembly_duration_ms` histogram + `directory_lookup_failure_count` counter

What it doesn't test:

- Statuspage approval gate (no draft is created until an IC clicks "Draft status" via a slash command — strategy 3)
- Postmortem draft + Linear issue creation (triggered by `/incident-response resolve`)
- Real Grafana OnCall routing (we're hitting the webhook ingress directly, not going through OnCall)

**Safe to re-run**: the incident_id is unique per run. Channel names include a 6-char cryptographic nonce so two drills on the same day can never collide on `name_taken`. Channels accumulate until you archive them — `/incident-response resolve` auto-archives, or use `scripts/join-drill-channel.sh` then `conversations.archive` to clean up manually.

### 2. Real Grafana OnCall test alert

Once you trust strategy 1, set up a real OnCall outgoing-webhook integration for higher-fidelity testing:

1. In staging Grafana → OnCall → Outgoing webhooks → Create.
2. URL: `https://<ingress-host>/webhook/grafana-oncall` (the staging webhook ingress hostname).
3. HTTP method: `POST`. Trigger: `Alert group firing`. Signing secret: paste the same value you seeded into `incident-response/staging/grafana/oncall-webhook-hmac`.
4. In OnCall → Integrations → add a new "Alertmanager" or "Grafana Alerting" integration.
5. From that integration's Settings page, click "Send demo alert".

The demo alert fires through OnCall's real routing, signs with the same HMAC, and hits IncidentResponse. The difference from strategy 1: you're exercising OnCall's own webhook-emit pipeline (retries, signature format, header name) which catches drift if Grafana changes its OnCall API.

Fidelity benefit: if you wire OnCall's demo alert to a real escalation chain, you'll get real responder emails in the `notify_to_users_queue` and IncidentResponse will actually invite them to the war room. Set this up with a test-only escalation chain that pages a single on-call dummy user (not a real engineer).

### 3. Slack slash-command exercise

Once a war room exists (from strategy 1 or 2), exercise the IC-facing commands inside that channel. These paths aren't covered by the webhook drill.

```
/incident-response help                 — confirms bot is responsive + shows registered commands
/incident-response checklist            — re-posts the pinned checklist
/incident-response status draft         — generates a Statuspage draft via Bedrock (tests AI layer)
/incident-response status send          — exercises the approval gate (button click required)
/incident-response silence              — disables the 15-min nudge for this incident
/incident-response resolve              — full 9-step resolution:
                                  1. Load incident (via slack-channel-index GSI)
                                  2. Fetch recent commits for deploy timeline
                                  3. Generate postmortem via Bedrock
                                  4. Create Linear issue
                                  5. Delete nudge schedule
                                  6. Post 1–5 pulse-rating buttons
                                  7. Flip incident to RESOLVED + audit
                                  8. Post public "Resolved" announcement
                                  9. Archive the channel
```

Each of these paths writes its own audit events — re-run `npm run observe:staging` after each to see the trail grow.

**Statuspage approval-gate test:** `/incident-response status draft` then `/incident-response status send` → click the "Approve & Publish" button in the Block Kit message. The audit table should show `STATUSPAGE_DRAFT_APPROVED` *before* `STATUSPAGE_PUBLISHED`. The `statuspage-approval-gate.ts` unit tests assert this ordering, but running it live is the only way to catch Slack-side Block-Kit regressions.

**Linear postmortem test:** after `/incident-response resolve`, check the audit table for `POSTMORTEM_CREATED` with a `linear_issue_url` — clicking that URL opens the Linear issue. If resolve logs `"Failed to create postmortem draft in Linear"` with `teamId must be a UUID`, your `linear/team-id` secret holds a team key instead of a UUID; fix via [`docs/troubleshooting.md`](troubleshooting.md) § "Linear errors".

**Bedrock test:** `/incident-response status draft` or `/incident-response resolve` should produce a coherent Bedrock-generated body. If the audit trail shows a template fallback (`"Bedrock postmortem failed — returning template"`), Claude 4.x is likely refusing on-demand invocation — switch to `us.anthropic.*` inference profile IDs per [`docs/troubleshooting.md`](troubleshooting.md) § "Bedrock errors".

### 4. Direct SQS enqueue

For testing the processor in isolation (bypassing the webhook ingress):

```bash
QUEUE_URL=$(tofu -chdir=../landing-zone/live/staging/aws/incident-response-platform output -raw incident_events_queue_url)
aws sqs send-message \
  --region us-west-2 \
  --queue-url "$QUEUE_URL" \
  --message-group-id "direct-test-$(date +%s)" \
  --message-deduplication-id "direct-test-$(date +%s)" \
  --message-body '{"type":"ALERT_RECEIVED","payload":{…GrafanaOnCallPayloadSchema…}}'
```

Use case: debugging a processor bug where the webhook side is fine but the assembler isn't behaving. Rarely useful — strategy 1 exercises more of the path at roughly the same effort.

### 5. Full tabletop + live-fire drill

The highest-fidelity exercise, scripted as a team activity in [`artifacts/incident-drill-playbook.md`](../artifacts/incident-drill-playbook.md). Uses real responders, real Slack workspace, real Statuspage page, and a cutover from tabletop → live-fire with a synthetic alert injected into production-shaped OnCall. Run quarterly per the playbook.

## Common drill gotchas

| Symptom | Likely cause |
|---|---|
| `scripts/fire-drill.sh` returns `401 Invalid signature` | HMAC secret in Secrets Manager differs from what the webhook handler has cached. It refreshes on first failure + retries once; if that still fails, restart the pods: `kubectl rollout restart deploy/incident-response-webhook -n tenants-protohype`. |
| Drill returned `200` but no Slack channel appears | Check the processor pod logs (`kubectl -n tenants-protohype logs deploy/incident-response-processor`) for Bolt connection errors. SLACK_APP_TOKEN must be a valid `xapp-…` with `connections:write` scope. |
| `observe-incident.sh` shows DDB row but no audit events | Processor crashed before reaching the audit write. Tail the processor logs and look for a stack trace. |
| DLQ depth > 0 | An incident event failed 3 times and landed in the DLQ. The PrometheusRule on the `incident-response-{env}-incident-events` DLQ fires at ≥1. Inspect + drain via `aws sqs receive-message`. |
| Slack channel assembles but has no responders | Expected for drills — `integration_id` and `team_id` are synthetic, so both OnCall escalation-chain lookup and WorkOS directory lookup return empty. The IC sees a "responder auto-invite failed" message. Run `npm run drill:join:staging -- --user U…` to land yourself in the room (see "Invite yourself" below); use `/incident-response invite @user` to add others. |

## Slack prerequisites that catch new operators

Two things that block drills for people doing first-time setup:

1. **`/incident-response` must be registered as a slash command in your Slack app.** If `/incident-response help` returns `"/incident-response is not a valid command"`, the command isn't declared in the app's config. Fix → [`docs/slack-app-setup.md`](slack-app-setup.md) § 5.

2. **War rooms are private channels.** The bot creates the channel and is the only member. Non-members can't see private channels in Slack's channel browser. The `scripts/fire-drill.sh` output prints a reminder + the `channel_id` the bot created — invite yourself via the API.

## Invite yourself to the drill channel

### The script (recommended)

`scripts/join-drill-channel.sh` pulls the bot token from Secrets Manager, finds the freshest `incident-response-p1-*` channel (within the last 120s), and invites you via `conversations.invite`. Typical flow:

```bash
npm run drill:staging
npm run drill:join:staging -- --user U0123ABCD
#   or: SLACK_USER_ID=U0123ABCD npm run drill:join:staging
```

It polls for up to ~24s (8 × 3s) so you can fire the drill and immediately run the join — the assembler usually has the channel up within 3–5s.

### Raw curl (if you don't want the script)

Two Slack API calls: fetch the channel, invite yourself.

```bash
# 1. Pull the bot token (one-time per shell)
BOT_TOKEN=$(aws secretsmanager get-secret-value --region us-west-2 \
  --secret-id incident-response/staging/slack/bot-token --query SecretString --output text)

# 2. List the private channels the bot created; copy the id you want
curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  'https://slack.com/api/conversations.list?types=private_channel&limit=50' \
  | jq '.channels[] | select(.name | startswith("incident-response-p1-")) | {id, name, created}'

# 3. Invite yourself (replace both IDs)
curl -sS -X POST -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-type: application/json; charset=utf-8' \
  -d '{"channel":"C_CHANNEL_ID","users":"U_YOUR_USER_ID"}' \
  https://slack.com/api/conversations.invite | jq
```

### Finding your Slack user ID

Click your avatar in Slack → **Profile** → ⋯ (More) → **Copy member ID**. Format is `U` + ~10 alphanumeric chars.

From the CLI (uses the email you log into Slack with):

```bash
curl -sS -H "Authorization: Bearer $BOT_TOKEN" \
  "https://slack.com/api/users.lookupByEmail?email=you@yourcompany.com" | jq .
```

### Workspace admin path

If you're a Slack Workspace Admin or Owner, you can join any private channel via `https://<workspace>.slack.com/admin` → **Channels** → search + Join. Regular members can't.

## A minimal happy-path drill

Copy-paste, ~5 minutes elapsed:

```bash
# 1. Fire a synthetic P1
npm run drill:staging
# Note the incident ID from the output, e.g. drill-1776567890-12345

# 2. Invite yourself to the new war-room channel
SLACK_USER_ID=U0123ABCD npm run drill:join:staging

# 3. Snapshot the DDB state — should show status=ROOM_ASSEMBLED + a full audit trail
npm run observe:staging

# 4. In the war room channel, exercise slash commands:
/incident-response help
/incident-response status draft               # Bedrock-generated Statuspage draft
# (Click "Approve & Publish" in the Block Kit message — exercises the approval gate)
/incident-response resolve                    # Bedrock postmortem → Linear issue → channel archive

# 5. Final observation — status=RESOLVED, audit should show
#    INCIDENT_RESOLVED + POSTMORTEM_CREATED + STATUSPAGE_PUBLISHED + WAR_ROOM_ARCHIVED
npm run observe:staging
```

If all five steps succeed, staging is exercising every path a real P1 would hit (modulo real responder invite + real-Statuspage customer visibility, which you wouldn't want firing against a drill anyway). The war-room channel archives itself on step 4 — no cleanup required.

## CI drill

The same scripted drill runs nightly in CI via `.github/workflows/nightly-drill.yml` and `scripts/ci-drill.sh`. The workflow:

1. Fires a synthetic P1 with a deterministic incident ID (`ci-drill-$(date +%s)-$GITHUB_RUN_ID`).
2. Polls DDB for `ROOM_ASSEMBLED` + captures the `slack_channel_id`.
3. Asserts the required audit trail (`WAR_ROOM_CREATED`, `CONTEXT_SNAPSHOT_ATTACHED`, `CHECKLIST_PINNED`).
4. Archives the Slack channel + deletes the DDB row to keep staging tidy for the next run.

**Gated off by default.** The workflow is guarded by `if: ${{ vars.INCIDENT_RESPONSE_DRILL_ENABLED == 'true' }}` — set the GH repo variable when you've wired the OIDC role (`AWS_DRILL_ROLE_ARN` secret). Until then the job is a no-op on schedule and workflow_dispatch. See the workflow's header comment for the exact IAM the role needs.

## Reset between drills

Staging accumulates synthetic incidents over time. To wipe clean:

```bash
# Scan for drill-* incident IDs and batch delete. Not destructive — staging
# never has real data. Run occasionally; not required between individual drills.
aws dynamodb scan --region us-west-2 --table-name incident-response-staging-incidents \
  --projection-expression 'PK,SK' \
  --filter-expression 'begins_with(PK, :prefix)' \
  --expression-attribute-values '{":prefix":{"S":"INCIDENT#drill-"}}' \
  --query 'Items[*].{PK:PK,SK:SK}' --output json \
  | jq -r '.[] | "\(.PK.S)\t\(.SK.S)"' \
  | while IFS=$'\t' read -r pk sk; do
      aws dynamodb delete-item --region us-west-2 --table-name incident-response-staging-incidents \
        --key "{\"PK\":{\"S\":\"$pk\"},\"SK\":{\"S\":\"$sk\"}}"
    done

# Slack channels accumulate too — `/archive` them in bulk or use the Slack
# admin API to clean up by name prefix `incident-response-p1-`.
```
