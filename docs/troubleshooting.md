# Troubleshooting catalogue

Every concrete error this app has surfaced during bring-up, with root cause and fix. Keyed on the exact error text where possible so you (or the next operator) can grep-find the answer instead of re-diagnosing.

The app runs as a Platform tenant in namespace `tenants-protohype`: a `incident-response-webhook` Deployment (behind ingress-nginx) and a `incident-response-processor` Deployment (Slack socket-mode singleton). All `kubectl` examples assume `-n tenants-protohype`.

Sections:
- [Rollout / sync errors](#rollout--sync-errors)
- [Build / TypeScript errors](#build--typescript-errors)
- [Pod startup errors](#pod-startup-errors)
- [Runtime errors (processor logs)](#runtime-errors-processor-logs)
- [Slack errors](#slack-errors)
- [Secrets Manager errors](#secrets-manager-errors)
- [Grafana errors](#grafana-errors)
- [Bedrock errors](#bedrock-errors)
- [Linear errors](#linear-errors)
- [EventBridge Scheduler errors](#eventbridge-scheduler-errors)
- [Drill-specific gotchas](#drill-specific-gotchas)

## Rollout / sync errors

### ArgoCD app `OutOfSync` / `Degraded` after registering the entry

**Cause:** the chart referenced a value that isn't filled for this env, or the Platform isn't `Ready` yet (so the namespace/quota/IRSA don't exist).

**Fix:** confirm the Platform reconciled, then re-render to find the gap:

```bash
kubectl -n tenants-protohype get platform incident-response -o jsonpath='{.status.phase}'   # expect Ready
helm template incident-response chart -f chart/values-staging.yaml | less          # eyeball the rendered Secret/env
```

Empty `tenantInfra.*` env in the rendered output means the `incident-response-platform` `tofu output` values weren't filled into `chart/values-<env>.yaml`. See [`docs/deployment-guide.md`](deployment-guide.md) § 3.

### Grafana dashboard ConfigMap renders empty

**Cause:** `chart/dashboards/incident-response.json` isn't tracked in git, so a clean checkout renders an empty ConfigMap.

**Fix:** confirm the asset is tracked — `git ls-files chart/dashboards/` must be non-empty. The repo `.gitignore` is scoped so the dashboard filename does not collide with the secret-seed ignore patterns.

## Build / TypeScript errors

### `npm run typecheck` fails with errors spanning lib-dynamodb, secrets-manager, scheduler, OTel — but runtime works

**Cause:** Stale `package-lock.json`. The peer-dependency graph drifted between incompatible minor versions — typically `@aws-sdk/util-dynamodb` at an older release than `@aws-sdk/lib-dynamodb` + `@aws-sdk/client-dynamodb`, which makes `GetCommand`'s middleware type signature mismatch. You'll see errors like:

```
Argument of type 'GetCommand' is not assignable to parameter of type 'Command<any, GetCommandInput, any, GetItemCommandOutput | GetCommandOutput, …>'
Module '"@aws-sdk/client-secrets-manager"' has no exported member 'SecretsManagerClient'
```

Both of these are type-declaration issues — the runtime exports are intact (that's why `npm run dev` works even while typecheck fails).

**Fix:** clean reinstall pins all transitive AWS SDK versions to the same minor release:

```bash
rm -rf node_modules package-lock.json
npm install
npx tsc --noEmit   # should now report 0 errors
```

Commit the refreshed `package-lock.json`. CI uses `npm ci` which needs the lockfile to be consistent.

### Docker build fails on the `npm run build` stage

**Cause:** the build stage runs `tsc` against the full `tsconfig.json`. A type error that lazy `ts-jest` would skip at test time fails the image build.

**Fix:** run `npm run typecheck` locally (it covers `test/**` too) before building. The Dockerfile's builder stage is the same `tsc` invocation, so a green local typecheck means a green image build.

## Pod startup errors

### Processor pod `CrashLoopBackOff`, logs show `Required env not set: X`

**Cause:** `src/utils/env.ts:requireEnv` throws when a required env var is absent. Either the var was added to `requireEnv` but not wired into the chart, or a seeded secret is missing a key.

**Fix:** audit the gap between `src/index.ts:requireEnv([...])` and the chart's env sources — `tenantInfra.*` (landing-zone outputs), `env.*` (plain values), and the ExternalSecret keys. Every name in `requireEnv` must have a corresponding source. Past misses: `SLACK_APP_TOKEN`, `LINEAR_TEAM_ID`, `NUDGE_EVENTS_QUEUE_ARN`, `SCHEDULER_GROUP_NAME`.

```bash
kubectl -n tenants-protohype logs deploy/incident-response-processor --previous --since=10m
```

### Pod stuck `CreateContainerConfigError` referencing the projected Secret

**Cause:** the ExternalSecret hasn't synced yet (or failed), so the k8s Secret the pod mounts via `envFrom` doesn't exist.

**Fix:**

```bash
kubectl -n tenants-protohype describe externalsecret incident-response
kubectl -n tenants-protohype get secret incident-response -o jsonpath='{.data}' | jq 'keys'
```

If the ExternalSecret shows `SecretSyncError`, the IAM role can't `GetSecretValue` on the `incident-response/<env>/*` ARNs, or a referenced secret doesn't exist. Seed the secret (`npm run seed:{env}`) and confirm the role's secrets-read scope in `landing-zone incident-response-platform`.

### `exec format error` in the container's logs / pod won't start

**Cause:** Architecture mismatch. The image was built for one architecture (often arm64 on Apple Silicon builders) and the node it landed on runs another. The binary can't execute.

**Fix:** build the image for the cluster's node architecture. The release workflow builds the published image; for a local one-off, pass `--platform` to match the nodes (e.g. `docker build --platform linux/arm64` for Graviton nodes).

### `Task failed container health checks` equivalent — readiness probe never passes

**Cause:** the `/health` probe command exits non-zero. A classic regression was `curl -f http://localhost:3001/health` — alpine doesn't ship curl, so every probe exited `curl: not found`.

**Fix:** the Dockerfile's `HEALTHCHECK` and the chart's probes use `wget`, which alpine busybox ships:

```
wget -qO- http://localhost:3001/health || exit 1
```

If the probe still fails, the app isn't reaching `listen` — check the startup logs for a Zod config throw before the HTTP server starts.

## Runtime errors (processor logs)

### `AutoPublishNotPermitted: Attempted to publish Statuspage.io incident for incident_id=… without a confirmed STATUSPAGE_DRAFT_APPROVED audit record`

**Cause — two possibilities:**

1. **Genuine invariant violation** — an unauthorised caller tried to publish without approval. Investigate immediately; this should be impossible through the normal code path (CI grep-gate blocks any call to `createIncident` outside the gate file).

2. **False positive from DDB `Limit` + `FilterExpression` interaction** — DynamoDB applies `Limit` BEFORE `FilterExpression`. A query with `Limit: 1` returns the earliest audit event by SK (e.g. `WAR_ROOM_CREATED`), then filters it out, yielding an empty `Items` array even when `STATUSPAGE_DRAFT_APPROVED` exists. The gate interprets empty Items as "no approval" and refuses.

**Fix:** `src/utils/audit.ts:verifyApprovalBeforePublish` must NOT use `Limit` when combined with `FilterExpression`. The per-incident audit trail is bounded (tens of events), so scanning all of them under `ConsistentRead` is trivial. If you see this error and the audit table DOES have a `STATUSPAGE_DRAFT_APPROVED` row for the incident, the fix regressed — remove the `Limit` parameter.

Quick diagnosis — check whether the approval row exists:

```bash
aws dynamodb query --region us-west-2 --table-name incident-response-{env}-audit \
  --key-condition-expression 'PK = :pk' \
  --expression-attribute-values '{":pk":{"S":"INCIDENT#<incident-id>"}}' \
  --query 'Items[*].[timestamp.S,action_type.S]' --output table
```

If `STATUSPAGE_DRAFT_APPROVED` is there, it's the Limit+Filter bug. If it isn't, the approval write actually failed — look for "CRITICAL: Audit write failed" in the processor logs around the click time.

### `Pass options.removeUndefinedValues=true to remove undefined values from map/array/set`

**Cause:** The DynamoDB DocumentClient's default incident-responseer rejects `undefined` field values. The `INCIDENT_RESOLVED` audit write passes `linear_issue_id: linearDraft?.linear_issue_id` — if Linear creation failed upstream, `linearDraft` is `undefined`, so the field resolves to `undefined`, and the incident-responseer throws.

**Fix:** `src/wiring/dependencies.ts` constructs the doc client with `{ marshallOptions: { removeUndefinedValues: true } }`. If this error returns, the option got removed — restore it. Prefer the option over individual `if (x) { key: x }` guards at call sites because the fields leak in through `linearDraft?.field` patterns throughout the codebase.

### `Schedule group incident-response-{env} does not exist.`

See [EventBridge Scheduler errors](#eventbridge-scheduler-errors) below.

### `conversations.create: An API error occurred: name_taken`

**Cause:** Two war-room channels tried to claim the same Slack channel name on the same day. Happens when two incidents share a prefix (real OnCall alert IDs with adjacent numeric values, or multiple drills on the same day whose first 6 chars of `incident_id` are identical).

**Fix:** `src/services/war-room-assembler.ts:channelName` appends a cryptographic nonce (6 hex chars, ~16M entropy) to the channel name:

```
incident-response-p1-YYYYMMDD-<id-prefix>-<nonce>
```

If you see `name_taken` with this fix in place, it means either (a) Slack workspace-wide uniqueness collided with a pre-existing archived channel (archived channels still reserve the name), or (b) the 16M entropy rolled an unlucky duplicate. Unarchive + rename the pre-existing channel, or retry the drill — the nonce will be different on the next run.

## Slack errors

### `/incident-response is not a valid command`

**Cause:** The slash command isn't registered in the Slack app config.

**Fix:** See [`docs/slack-app-setup.md`](slack-app-setup.md) § 5 — declare the command in the Slack app, reinstall, reseed the rotated bot token, `kubectl rollout restart deploy/incident-response-processor`.

### Processor log shows `slack.<api-call>: An API error occurred: missing_scope`

**Cause:** The bot token lacks a scope required for that API call.

**Fix:** Slack app → OAuth & Permissions → add the scope called out in the `needed:` field of the error response. Reinstall. Reseed the rotated `xoxb-…` token. See [`docs/slack-app-setup.md`](slack-app-setup.md) § 2 for the full scope list this app needs.

Specific known cases:
- `pins.add: missing_scope` → need `pins:write`
- `users.lookupByEmail: missing_scope` → need `users:read.email`
- `conversations.create: missing_scope` → need `groups:write` (for private channels) or `channels:manage` (for public)

### `401 Invalid signature` on the webhook

**Cause:** The HMAC signature in the `x-grafana-oncall-signature` header doesn't match what the webhook handler computes from `HMAC-SHA256(body, secret)`. Either:
- The secret the sender used ≠ the secret the handler cached
- The body was mutated in transit (unlikely — ingress-nginx passes the body through)

**Fix:**

1. Verify the sender is using the same secret in `incident-response/{env}/grafana/oncall-webhook-hmac`.
2. If you rotated the secret recently, the handler's in-memory cache (5-min TTL, keyed on `VersionId`) refreshes on the first verification failure and retries once. If it's still wedged, restart the webhook pods to force a fresh read:
   ```bash
   kubectl rollout restart deploy/incident-response-webhook -n tenants-protohype
   ```

### "No channel created" — but logs say `War room assembled`

**Cause:** The channel WAS created. It's **private** (all war rooms are `is_private: true`) so non-members can't see it in the channel browser. The bot is the only member; you aren't.

**Fix:** see [`docs/drills.md`](drills.md) § "Invite yourself to the drill channel" for the API invocation. There's no Slack UI self-invite path for private channels unless you're a workspace Admin.

## Secrets Manager errors

### `ResourceNotFoundException: Secrets Manager can't find the specified secret`

Three distinct causes — check in this order:

1. **Secret doesn't exist.** `aws secretsmanager describe-secret --secret-id incident-response/{env}/<name>` returns `ResourceNotFoundException`. Run the seeder: `npm run seed:{env}`.

2. **Secret is scheduled for deletion.** `describe-secret` succeeds but shows `DeletedDate`. Restore:
   ```bash
   aws secretsmanager restore-secret --region us-west-2 \
     --secret-id incident-response/{env}/<name>
   ```

3. **ExternalSecret references a name that doesn't match the seeded path.** Compare the chart's `externalsecret.yaml` remoteRefs against `secrets.template.json` — the CI inventory-drift gate normally catches this, but a local edit can drift.

### Seeder shows `OK : put:` for every secret but the pod can't find them

**Cause:** Account mismatch. Your AWS CLI profile for seeding points at one account; the cluster's IAM role authenticates against another. The secrets got written to the wrong account.

**Fix:**

```bash
# Confirm the seeding identity
aws sts get-caller-identity

# Confirm the Pod Identity association exists for the incident-response ServiceAccount
```

Both should reference the same AWS account ID — the one the cluster's `incident_response_irsa` role lives in.

## Grafana errors

### OnCall curl returns `530 Origin Unreachable`

**Cause:** Wrong OnCall URL. OnCall runs on its own cluster topology, independent of your Grafana Cloud stack's cluster. A stack in `prod-us-west-0` can have its OnCall at `oncall-prod-us-central-0.grafana.net`.

**Fix:** find the authoritative URL by opening OnCall in the Grafana UI + copying the base from the browser URL. Update `GRAFANA_ONCALL_BASE_URL` in the chart's `env.*` (currently hardcoded in `src/wiring/dependencies.ts` as `https://oncall-prod-us-central-0.grafana.net`; override if your region differs).

### OnCall returns `404` on `/oncall/api/v1/integrations`

**Cause:** Token is valid but doesn't have permission to hit OnCall's API. Or you've used the wrong URL entirely.

**Fix:** OnCall's REST API is at `/oncall/api/v1/…` (note the `/oncall/` prefix). `Authorization: <token>` header — no `Bearer` prefix. See [`docs/secrets.md`](secrets.md) § "Grafana credentials — which is which" for the full auth matrix.

### Grafana Cloud Mimir returns `401`

**Cause:** Either the `glc_…` read token lacks `metrics:read` scope, or the `cloud-org-id` (Mimir tenant ID) doesn't match the token's issuing stack.

**Fix:**
1. Confirm the access policy has `metrics:read` at grafana.com → Administration → Cloud access policies.
2. Confirm `cloud-org-id` is the Mimir tenant ID (shown on grafana.com → Connections → Hosted Prometheus Metrics → "Username / Instance ID"), not the stack-level instance ID.

## Bedrock errors

### `Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.`

**Cause:** AWS Bedrock requires Claude 4.x-family models to be invoked through a **cross-region inference profile** when using on-demand throughput. Direct foundation-model invocation only works with provisioned-throughput commitments (pre-purchased capacity, $$). The app uses on-demand throughput — the cheap path for bursty incident volume.

**Fix:** in `src/ai/incident-response-ai.ts`, switch the model IDs from foundation-model names to inference-profile IDs. For the US geo (us-west-2, us-east-1, us-east-2):

```ts
const SONNET_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const HAIKU_MODEL_ID  = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
```

The `us.` prefix is the cross-region inference profile for the US — AWS routes each request across multiple regions for capacity availability. Equivalent profiles exist for EU (`eu.`) and APAC (`apac.`).

**Also update the IAM policy** in `landing-zone incident-response-platform`. The role's `bedrock:InvokeModel` permission needs:

```
# The inference-profile ARNs
arn:aws:bedrock:<region>:<account>:inference-profile/us.anthropic.claude-sonnet-4-6
arn:aws:bedrock:<region>:<account>:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0
# The underlying foundation models the profile routes to — wildcard region
# because the profile hits multiple regions.
arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6
arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0
```

**Degraded fallback:** `IncidentResponseAI.generatePostmortemSections()` has an inline fallback template that renders a skeleton postmortem when Bedrock fails. An incident resolve with Bedrock failing still produces a Linear issue, but the issue body is generic. Look for `"Bedrock postmortem failed — returning template"` in the processor logs.

## Linear errors

### `Argument Validation Error - teamId must be a UUID.`

**Cause:** Linear's GraphQL API expects **team UUIDs** (e.g. `a1b2c3d4-e5f6-7890-abcd-1234567890ab`), not team **keys** (short identifiers like `ENG` or `PLAT`). The seeded `linear/team-id` secret holds a team key instead of a UUID.

**Fix:** get the team UUID via the GraphQL API and reseed:

```bash
LINEAR_KEY=$(aws secretsmanager get-secret-value --region us-west-2 \
  --secret-id incident-response/{env}/linear/api-key --query SecretString --output text)

curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq '.data.teams.nodes'

# Find the team you want, copy its `id` field, then:
aws secretsmanager put-secret-value --region us-west-2 \
  --secret-id incident-response/{env}/linear/team-id \
  --secret-string '<the-UUID>'

# Restart the processor so it picks up the rotated secret
kubectl rollout restart deploy/incident-response-processor -n tenants-protohype
```

Same pattern for `linear/project-id` (also a UUID, from `{ projects { nodes { id name } } }`).

## EventBridge Scheduler errors

### `Schedule group incident-response-{env} does not exist.` — nudge never fires

**Cause:** The `NudgeScheduler.scheduleNudge` call targets a named schedule group, but the group doesn't exist. `CreateSchedule` errors; `scheduleNudge` has a try/catch that warn-logs and continues, so the rest of assembly succeeds but the 15-min nudge never arrives.

**Fix:** the schedule group is owned by the `landing-zone incident-response-platform` component (`scheduler.tf`). Confirm it's applied for this env:

```bash
aws scheduler list-schedule-groups --region us-west-2 \
  --query 'ScheduleGroups[?Name==`incident-response-{env}`]'
```

If empty, the `incident-response-platform` component wasn't applied (or `scheduler_group_name` wasn't wired into `chart/values-<env>.yaml` under `tenantInfra.schedulerGroupName`). Apply the substrate and re-render.

**Recover an in-flight incident whose nudge was dropped:** create the schedule manually — `aws scheduler create-schedule` with the queue ARN as target. See `scripts/fire-drill.sh` output for the CLI pattern.

## Pod has a stale secret value after rotation

**Symptom:** you updated a secret via `aws secretsmanager put-secret-value`, but the running pod keeps using the old value — Linear still complains about the old team ID, or Slack rejects the old bot token.

**Cause:** the pod reads the projected k8s Secret (synced by the External Secrets Operator) at start, via `envFrom`. ESO re-syncs on its `refreshInterval` (1h), but the running pod won't pick up the new value until it restarts.

**Fix:** restart the workload to roll the pods with fresh secrets:

```bash
kubectl rollout restart deploy/incident-response-processor deploy/incident-response-webhook -n tenants-protohype
kubectl rollout status  deploy/incident-response-processor -n tenants-protohype
```

For the webhook, the HMAC secret is additionally cached in-process with a 5-min TTL and `VersionId`-aware invalidation, so HMAC rotations usually propagate within 5 minutes even without a restart.

## Drill-specific gotchas

### Drill fired, HTTP 200, no channel visible

Same as the Slack section above — the channel is private. See [`docs/drills.md`](drills.md) § "Invite yourself to the drill channel".

### Drill fired, but processor logs nothing

**Cause:** SQS message delivered but the processor pod either hasn't rolled to the new image or has crashed.

**Fix:**

```bash
# Is the processor running at all?
kubectl -n tenants-protohype get deploy incident-response-processor \
  -o jsonpath='{.status.readyReplicas}/{.status.replicas}'
kubectl -n tenants-protohype logs deploy/incident-response-processor --since=5m

# What's in the queue?
aws sqs get-queue-attributes --region us-west-2 \
  --queue-url <IncidentEventsQueueUrl> \
  --attribute-names ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible

# If `NotVisible` > 0, the message is being processed (or the processor is hung)
```

### Drill resolved but incident state stays `ROOM_ASSEMBLED`

**Cause:** The resolved-state webhook was accepted but the processor's `ALERT_RESOLVED` handler didn't run. Most likely `handlers/alert-resolved.ts` isn't registered in the event registry, or the processor is stopped.

**Fix:** check the processor is running (see above), then the event registry:

```bash
kubectl -n tenants-protohype logs deploy/incident-response-processor --since=5m | grep 'IncidentResponse processor started'
```

The startup log line includes `incident_events: [...]` — confirm `ALERT_RESOLVED` is in that list.

---

If you hit something not covered here, add it to this doc with the error text, cause, and fix. The next operator (possibly future-you in 3 months) will thank you.
