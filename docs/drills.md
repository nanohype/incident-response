# Seeing IncidentResponse work: drills + observability

IncidentResponse is a P1 incident orchestrator. You can't just wait for a real P1 to know it's working — you have to exercise it deliberately. This doc covers five strategies, from cheapest to most realistic, and the scripted drill harness that covers the first of them.

The **drill harness** (`scripts/fire-drill.sh` + `scripts/observe-incident.sh`) is the fastest way to see the whole system move. Once staging is deployed, every secret is seeded, and `ingress.host` in `chart/values-staging.yaml` names your webhook hostname instead of the placeholder this repository ships:

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
| **Pod logs** | Processor stderr (app-level events, trace-correlated) | `kubectl -n tenants-incident-response logs deploy/incident-response-processor -f` |
| **DynamoDB** | Incident state (`ALERT_RECEIVED → ROOM_ASSEMBLING → ROOM_ASSEMBLED → RESOLVED`), full audit trail | `incident-response-staging-incidents` + `incident-response-staging-audit` tables, or via `scripts/observe-incident.sh` |
| **SQS** | In-flight events + DLQ depth (must stay 0) | `incident-response-staging-incident-events.fifo`, `incident-response-staging-nudge-events`, `incident-response-staging-sla-check-events`, plus the DLQ |
| **Grafana / AMP** | Pod health, CPU/memory, restarts, the three SLO panels | The org Grafana → the reconciled `incident-response` dashboard, over Amazon Managed Prometheus; or `kubectl -n tenants-incident-response get pods` for liveness |

The drill harness synthesises the first three into a single command flow. Pod metrics land in Amazon Managed Prometheus and traces in the in-cluster Tempo, both via Grafana Alloy; pod logs land in the in-cluster Loki via Alloy's pod tail.

## Strategies in order of effort

### 1. HMAC-signed synthetic webhook *(the harness)*

The cheapest way to exercise the full P1 path. `scripts/fire-drill.sh`:

1. Establishes every environment's webhook hostname (`ingress.host` in `chart/values-{env}.yaml`, the name external-dns published for the ALB) and resolves a host and a port from the drilled one's.
2. Constructs the request URL from validated components and parses it back with `new URL()` to confirm it addresses the host that was checked.
3. Reads the HMAC secret from `incident-response/{env}/grafana/oncall-webhook-hmac`.
4. Builds a payload that passes the webhook handler's Zod schema.
5. Signs with HMAC-SHA256 (hex) under header `x-grafana-oncall-signature`.
6. POSTs to `https://<ingress-host>/webhook/grafana-oncall` — the path is `ingress.path` from the same values file, so the drill follows the listener rule rather than assuming one.
7. Checks the connection curl reports against the host every check was run on, and reports a mismatch as a defect.
8. Tells you the incident ID + what to watch next.

It needs `node` on `PATH` in every mode, including the two that send nothing: the URL parser is node's.

**Name every environment's hostname before your first drill.** `chart/values-{env}.yaml` ships `ingress.host` as a `.example.com` placeholder so the chart renders without naming anybody's DNS zone. A placeholder is a stand-in, not an identity, so a fresh checkout is three environments the drill cannot locate — and it will not fire at any of them:

```
$ bash scripts/fire-drill.sh --env staging --dry-run
[drill] FAIL: nothing establishes a webhook host for staging, so this drill has no
idea where it would be firing.

[drill] environment identities:
  development  UNKNOWN     chart/values-development.yaml carries the placeholder …
  staging      UNKNOWN     chart/values-staging.yaml carries the placeholder …
  production   UNKNOWN     chart/values-production.yaml carries the placeholder …

[drill] Set chart/values-staging.yaml's ingress.host to the hostname external-dns
published for the staging ALB, or set DRILL_WEBHOOK_HOST_STAGING (or
DRILL_WEBHOOK_URL_STAGING) to it. If staging has no webhook deployment, say so:
DRILL_WEBHOOK_HOST_STAGING=none.
```

**A drill is a pair: a signing identity and a destination.** It signs with `incident-response/<env>/grafana/oncall-webhook-hmac`, so a target resolved for one environment and signed for another puts a production signature on a staging load balancer. The invariant, stated once:

> A payload signed for environment X reaches only environment X's webhook host, or nothing is sent.

Holding that takes an authoritative answer to *which host belongs to which environment* — for every environment, not only the one being drilled. A drill that cannot name staging's host cannot prove it is missing staging's load balancer. So the drill builds one identity map before it resolves anything, from the same three sources for every environment:

| Source | What it is |
|---|---|
| `chart/values-<env>.yaml` → `ingress.host` | Falling back to `chart/values.yaml` — the same two files, in the same order, that Helm renders that environment's Ingress from. Reading them needs a checkout and nothing else: no kubeconfig, no cluster reachability, which is what lets one command work from a laptop and from CI |
| `DRILL_WEBHOOK_HOST_<ENV>` | A hostname, optionally with a port |
| `DRILL_WEBHOOK_URL_<ENV>` | A base URL, scheme included |

An identity is a host **and** a port. Two environments can sit behind one hostname on two ports — one load balancer, two listeners — so a port left out of the identity is half an answer to "where does this environment live", and half an answer cannot prove a request missed the other half.

Hosts compare canonically — a scheme, a path, userinfo, letter case and a trailing root dot can all differ between two strings naming one load balancer, so none of them survives the comparison. Ports compare canonically too: the drill speaks https and nothing else, so a bare host and the same host written `:443` are one authority spelled two ways. Each environment ends up in one of four states:

| State | Meaning |
|---|---|
| **known** | One canonical host and port, agreed by every source that named one |
| **absent** | `DRILL_WEBHOOK_HOST_<ENV>` or `DRILL_WEBHOOK_URL_<ENV>` is `none` — that environment has no webhook deployment, so it claims no host. The one way to say "not deployed" out loud |
| **unknown** | No source names a host. A fresh checkout is three unknowns |
| **conflict** | Two sources name a different host, or a different port. Agreeing on the hostname and disagreeing about the port is a disagreement about which listener the environment is, and letting the first source read win would settle it by ordering rather than by fact |

Then, before anything is signed:

| What has to hold | What it refuses |
|---|---|
| Every environment is known or absent | An unknown or a conflict anywhere — including environments this run is not drilling. A host nobody can name is a host nothing can be proved to miss, and a drill that cannot prove where it is firing does not fire |
| No two environments claim one host | Two identities that resolve to the same hostname. One host serving two environments is a host where one environment's signature lands on the other's listener. Hostnames only, deliberately: two environments behind one hostname on two ports are still two that a DNS record, a certificate and a load balancer cannot tell apart |
| The drilled environment is known | Drilling an environment declared to have no webhook host |
| The request goes to the drilled environment's host **and port** | A `--host`, `--url` or scoped variable that spells a different host or a different port, whether or not what it spells belongs to another environment. `--from-cluster` is the exception — it fires at the Ingress the cluster serves, which still has to miss every other environment's host, and warns when the chart and the cluster have drifted |
| Overrides are environment-scoped | An unscoped `DRILL_WEBHOOK_HOST`, `DRILL_WEBHOOK_URL`, `DRILL_HMAC_SECRET_ID` or `DRILL_HMAC_SECRET`, by name — one value applies to every `--env` |
| The secret belongs to `--env` | A secret id naming another environment's tree — the same misfire read backwards. Compared with letter case folded, the way every host comparison is: `/STAGING/` names the staging tree exactly as `/staging/` does |

Ways to name a target, once every identity is established:

| Want | Do |
|---|---|
| Fire at your own deployment, every time | Put the real hostname in `ingress.host`, which is what ArgoCD renders the Ingress from anyway. Nothing else needed |
| Fire without touching the values file | `DRILL_WEBHOOK_HOST_STAGING=webhook.staging.acme.io` — it establishes staging's identity *and* is the target |
| Assert the target on the command line | `bash scripts/fire-drill.sh --env staging --host webhook.staging.acme.io` (or `--url https://…`). It has to be staging's established host *and* port; a flag is a way to spell an identity, not a way to overrule one |
| Fire at whatever the cluster actually has | `bash scripts/fire-drill.sh --from-cluster` — reads `spec.rules[0].host` off the live webhook Ingress with `kubectl` |
| Say an environment is not deployed | `DRILL_WEBHOOK_HOST_DEVELOPMENT=none`. Every run that leans on it says so on stderr — it is the one claim here nothing can check |

The transcripts below assume a checkout where `chart/values-staging.yaml` names `webhook.staging.acme.io`, `chart/values-production.yaml` names `webhook.acme.io`, and `DRILL_WEBHOOK_HOST_DEVELOPMENT=none`.

```
$ bash scripts/fire-drill.sh --env production --host webhook.staging.acme.io:8443 --check-target
[drill] FAIL: --host resolves to 'webhook.staging.acme.io:8443', whose host is
staging's webhook host — and this drill signs with
incident-response/production/grafana/oncall-webhook-hmac.

[drill] environment identities:
  development  no webhook deployment    from DRILL_WEBHOOK_HOST_DEVELOPMENT
  staging      webhook.staging.acme.io  from chart/values-staging.yaml
  production   webhook.acme.io          from chart/values-production.yaml

[drill] Drill staging with --env staging.

$ DRILL_WEBHOOK_HOST_PRODUCTION=webhook-old.acme.io bash scripts/fire-drill.sh --env production --check-target
[drill] FAIL: two sources name a different production webhook host or port —
DRILL_WEBHOOK_HOST_PRODUCTION names 'webhook-old.acme.io',
chart/values-production.yaml names 'webhook.acme.io'. While they disagree there is
no fact about where production lives, and a production drill cannot prove it is
missing it.
…
[drill] Make them agree, or drop one of them.

$ DRILL_WEBHOOK_HOST=webhook.staging.acme.io bash scripts/fire-drill.sh --env production --check-target
[drill] FAIL: DRILL_WEBHOOK_HOST is set, and it applies to every --env. Use the
environment-scoped name instead: DRILL_WEBHOOK_HOST_PRODUCTION …
```

### Where the request itself comes from

Knowing which host belongs to which environment settles where a request *should* go. It does not settle where it goes. A URL assembled by pasting strings together answers that second question on its own: everything before an `@` is userinfo, so `ingress.path` of `@other.host/webhook` pasted onto a checked base URL moves the authority to `other.host` while every text comparison still reads the checked host. Query strings, fragments, backslashes, protocol-relative `//host` and bracket parsing are the same trick in different clothes.

So the URL is not assembled from strings. It is constructed from four components, and no caller-supplied string ever reaches the authority position:

| Component | Where it comes from | What it is held to |
|---|---|---|
| scheme | fixed | Always `https`. `--url http://…` is refused rather than honoured, and curl runs with `--proto '=https'` |
| host | the identity map, or a flag the map agreed to | A hostname or a bracketed IP literal. No scheme, path, port or userinfo survives into it — and a bare host carrying an `@` is refused rather than trimmed, exactly as a base URL carrying one is |
| port | whatever came with the host | Digits, 1–65535, or nothing. Nothing and `443` are the same port, because the scheme is fixed at https |
| path | `ingress.path` | Must begin with `/`; refused for `@`, `?`, `#`, `%`, a backslash, whitespace, a control character, an empty segment, a `.`/`..` segment or a leading `//`; then percent-encoded per segment against the unreserved set, `/` kept as the separator |

The refusal list and the encoder are deliberately redundant — two independent implementations of one constraint, so a character that slips past either is still harmless after the other.

Then the assembled URL is parsed back with node's `new URL()`, which resolves an authority by the rules curl resolves one by rather than by another pass of shell text handling. The run refuses unless the scheme is `https`, `username` and `password` are both empty, the host component reads on its own as nothing but a host, and `hostname`, `port` and `pathname` are the components that went in — with no port and `443` read as the same port, since https implies one and a parser prints the shorter spelling. A disagreement between the parser and the identity map is refused, not reconciled: it means one of the two is wrong about where the request goes, and neither answer makes sending it right.

Read the `hostname` half of that precisely. Both sides go through one parser, so it establishes that the assembly did not move the authority — that the port and the path concatenated on did not turn into a host. It does not establish that the host belongs to the environment being drilled, which is the identity map's question and is settled before anything here is built, and it does not tell two spellings of one address apart, because one parser reads both the same way. The part of it that can fail on a well-formed URL is the shape check on the component itself, which is a second reading of what the shell's own authority handling established.

Last, after the POST, curl's `%{url_effective}`, `%{remote_ip}` and `%{remote_port}` go back through the same parser. A host there that is not the host every check ran on is reported as a defect in this script — loudly, non-zero — rather than tolerated. Be clear about what that buys: by the time curl can report an effective URL the request has already left. The construction and the parser check are what stop a misdirected request from being sent; this last one is what stops a misdirected request from being reported as a drill. (`--connect-to` is deliberately unused: its rules key on the URL's own authority, so the only form that pins anything is the match-all form, which hides the very mismatch this is here to surface.)

**Three hooks for scripting.** `bash scripts/fire-drill.sh --env <env> --check-target` is the whole verdict: it builds the map, resolves the target, constructs the URL, parses it back, and exits zero with the map, the request and the secret id, or non-zero with the reason and what to configure. It contacts nothing and needs no credentials beyond `node` — `.github/workflows/drill.yml` runs exactly this and holds no second opinion of its own. `--print-host` prints the host component of the request URL and nothing else, after the same checks: that component is what the URL is built from and what the parser confirmed the built URL addresses, so it describes the request the drill sends up to the point where the request leaves. `--print-url` prints the whole request URL the same way, which is the answer when the port matters — a hostname alone does not say which listener a request reaches, and widening `--print-host` to `host:port` would quietly break every caller feeding it to a DNS lookup. One reporting flag per run; two would mean one answer silently discarded. Whether curl agreed is the check after the POST, and it prints a defect when it did not.

`test/unit/drill-target-resolution.test.ts` holds the invariant against four HTTPS listeners it starts itself. Three are owned by an environment and the fourth by nobody, and that ownership is ground truth — so a `--env X` run observed anywhere but X's listener is a failure no matter what the configuration claimed. On top of that: every configuration that leaves an identity unestablishable, contradictory or shared must deliver nothing, and every configuration that establishes all three must actually fire. Signatures are verified with this repository's own `verifyHmacSignature`, bodies with its own `GrafanaOnCallPayloadSchema`.

The same file attacks the construction as well as the derivation: hostile `ingress.host`, `DRILL_WEBHOOK_URL_<ENV>` and `ingress.path` values in every shape that can move an authority, each asserting zero deliveries at every listener; the spellings that are legitimate still delivering; and — through a curl stand-in that really does send the request elsewhere and really does report where it went — the post-request check firing on a construction defeated upstream of it.

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

**Check the target without firing.** `--dry-run` resolves the URL, builds the payload, and stops. It contacts nothing and needs no credentials, so it is the cheapest way to confirm a fork is wired before you go looking for AWS problems:

```bash
bash scripts/fire-drill.sh --env staging --host webhook.staging.acme.io --dry-run
#   [drill] webhook_url=https://webhook.staging.acme.io/webhook/grafana-oncall (resolved from --host)
#   [drill] dry run: skipping the Secrets Manager read of incident-response/staging/grafana/oncall-webhook-hmac (set DRILL_HMAC_SECRET_STAGING to sign anyway)
#   [drill] dry run — nothing sent
```

Set `DRILL_HMAC_SECRET_STAGING` and a dry run signs the payload too, without touching Secrets Manager. The name is scoped like every other override: one `DRILL_HMAC_SECRET` shared across environments would sign a staging drill with whichever environment's secret was exported last, so the unscoped name is refused.

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
QUEUE_URL=$(cd ../landing-zone/live/aws/workload-staging/us-west-2/staging/tenant-substrate \
  && terragrunt output -raw incident_events_queue_url)
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
| `scripts/fire-drill.sh` says an environment's host is `UNKNOWN` | `ingress.host` in that `chart/values-{env}.yaml` is still the placeholder this repository ships. Set it to that environment's webhook hostname, or `DRILL_WEBHOOK_HOST_{ENV}` — including for environments you are not drilling, since the drill has to prove it is missing them. `DRILL_WEBHOOK_HOST_{ENV}=none` if that environment has no deployment. See "Name every environment's hostname before your first drill" above. |
| `scripts/fire-drill.sh` returns `401 Invalid signature` | HMAC secret in Secrets Manager differs from what the webhook handler has cached. It refreshes on first failure + retries once; if that still fails, restart the pods: `kubectl rollout restart deploy/incident-response-webhook -n tenants-incident-response`. |
| Drill returned `200` but no Slack channel appears | Check the processor pod logs (`kubectl -n tenants-incident-response logs deploy/incident-response-processor`) for war-room assembly errors. `SLACK_BOT_TOKEN` must be a valid `xoxb-…` with the war-room scopes (`groups:write`, `chat:write`, `users:read.email`). |
| `observe-incident.sh` shows DDB row but no audit events | Processor crashed before reaching the audit write. Tail the processor logs and look for a stack trace. |
| DLQ depth > 0 | An incident event failed 3 times and landed in the DLQ. The PrometheusRule on the `incident-response-{env}-incident-events` DLQ fires at ≥1. Inspect + drain via `aws sqs receive-message`. |
| Slack channel assembles but has no responders | Expected for drills — `integration_id` and `team_id` are synthetic, so both OnCall escalation-chain lookup and WorkOS directory lookup return empty. The IC sees a "responder auto-invite failed" message. Run `npm run drill:join:staging -- --user U…` to land yourself in the room (see "Invite yourself" below); use `/incident-response invite @user` to add others. |

## Slack prerequisites that catch new operators

Two things that block drills for people doing first-time setup:

1. **`/incident-response` must be registered as a slash command in your Slack app.** If `/incident-response help` returns `"/incident-response is not a valid command"`, the command isn't declared in the app's config. Fix → [`docs/slack-app-setup.md`](slack-app-setup.md) § 5.

2. **War rooms are private channels.** The bot creates the channel and is the only member. Non-members can't see private channels in Slack's channel browser. The `scripts/fire-drill.sh` output points you at the channel name prefix; the `channel_id` lands in the DynamoDB incident row, which `npm run observe:staging` prints. Invite yourself via the API or the script below.

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

The same scripted drill runs in CI via `.github/workflows/drill.yml` and `scripts/ci-drill.sh`. Run it from the Actions tab → **drill** → **Run workflow**, picking an environment. The workflow:

1. Fires a synthetic P1 with a deterministic incident ID (`ci-drill-$(date +%s)-$GITHUB_RUN_ID`).
2. Polls DDB for `ROOM_ASSEMBLED` + captures the `slack_channel_id`.
3. Asserts the required audit trail (`WAR_ROOM_CREATED`, `CONTEXT_SNAPSHOT_ATTACHED`, `CHECKLIST_PINNED`).
4. Archives the Slack channel + deletes the DDB row to keep the environment tidy for the next run.

**What to configure.** The first step of a run checks these and fails with the list if any is missing — it never skips:

| Setting | What it is |
|---|---|
| secret `AWS_DRILL_ROLE_ARN` | IAM role with GitHub OIDC trust. Needs `secretsmanager:GetSecretValue` on `incident-response/<env>/grafana/oncall-webhook-hmac` + `incident-response/<env>/slack/bot-token`, and `dynamodb:GetItem/Query/DeleteItem` on `incident-response-<env>-*` |
| variable `INCIDENT_RESPONSE_DRILL_HOST_DEVELOPMENT` / `_STAGING` / `_PRODUCTION` | Each environment's webhook Ingress hostname — all three, not only the one being drilled, because a drill has to prove it is missing the other two. An environment whose `chart/values-<env>.yaml` already names your own hostname needs no variable, and a variable that disagrees with it is refused. An environment with no webhook deployment is declared rather than omitted: set it to `none`. There is no single unscoped variable on purpose — one hostname applied to every environment choice is one environment's signature delivered to another's load balancer |
| variable `INCIDENT_RESPONSE_DRILL_REGION` | Optional, defaults to `us-west-2` |

The preflight step runs `fire-drill.sh --env <env> --check-target` and checks the AWS role, and re-derives nothing else. Whether a drill would fire where it signs is one question with one answer; a workflow that read the repository variables itself would be a second opinion about which host belongs to which environment, and two opinions disagree — which is how a run gets blessed by one and misfired by the other. The role ARN is checked here only because it is the one requirement the script has no way to see.

**There is no cron.** The drill needs a deployed environment, an OIDC role, and a hostname — none of which this repository carries and each fork supplies for itself. A schedule would wake up nightly to report its own missing configuration. Add a `schedule:` trigger to `drill.yml` once the three settings above are in place and the drill passes on demand; the workflow header says where.

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
