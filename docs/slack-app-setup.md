# Slack app setup

IncidentResponse talks to Slack via a custom Slack app using **signed-HTTP Request URLs** — Slack POSTs slash commands and Block Kit interactions to endpoints on the webhook Deployment (behind the cluster's ingress controller), and each request is verified against the Slack **signing secret**. There is no socket mode and no app-level token. You need one Slack app per environment (staging + production should have separate apps pointing at separate workspaces).

This doc is a single-pass walkthrough from "blank account at api.slack.com" to "`/incident-response help` works in your workspace". Estimated time: 15 minutes.

## Prerequisites

- A Slack workspace where you're a **workspace Owner or Admin** (you need permission to install apps + create app-level tokens).
- The `incident-response/<env>/*` Secrets Manager path available for this environment (so you have somewhere to seed the tokens). The `landing-zone tenant-substrate` substrate + the seeder set this up.

## 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Name it something env-scoped: `IncidentResponse (staging)` / `IncidentResponse (production)`.
3. Pick the target workspace.
4. Create.

## 2. OAuth & Permissions — Bot Token Scopes

Left nav → **OAuth & Permissions** → scroll to **Scopes** → **Bot Token Scopes** → **Add an OAuth Scope**.

Add each of these. Missing any one of them causes a specific silent failure at runtime; the "why" column is the failure mode you'd hit without it.

| Scope | Why IncidentResponse needs it |
|---|---|
| `app_mentions:read` | React to `@incident-response` mentions in channels for future `/incident-response` slash-command-free entry points. |
| `chat:write` | Post messages in the war-room channel (context snapshot, checklist, nudges, pulse-rating). Without this, every `postMessage` returns `missing_scope` and the channel is empty. |
| `channels:manage` | Create public channels. Currently IncidentResponse only creates private ones, but keep this for future flexibility. |
| `channels:read` | Inspect public channel state (membership, topic). Used by the fallback "can I post here?" checks in slash-command handlers. |
| `groups:read` | Same as `channels:read`, for private channels. Required because IncidentResponse's own war rooms are private. |
| `groups:write` | Create private channels. **Load-bearing** — without this, war-room assembly fails at `conversations.create`. |
| `commands` | Register and receive `/incident-response` slash-command invocations. Slack won't route slash commands to the app without this scope. |
| `users:read` | Look up user info by ID during invite flows. |
| `users:read.email` | Look up Slack users by email. Used by `war-room-assembler.ts:inviteResponders` to convert responder emails (from OnCall escalation chains + WorkOS directory group) into Slack user IDs for `conversations.invite`. Without it, responder auto-invite silently fails for every responder. |
| `pins:write` | Pin the incident checklist message in the war-room channel. Checklist still posts without this scope but isn't pinned — looks broken on re-open. |

**Don't add scopes IncidentResponse doesn't use.** Every extra scope broadens what a leaked bot token could do. If you're tempted to add `admin`, `channels:history`, or anything Slack flags as "special" — don't.

## 3. The webhook host (Request URL base)

Both the slash command and interactivity Request URLs point at the webhook Deployment's public ingress host. That is the same host Grafana OnCall POSTs to — set per environment in the chart (`ingress.host`), e.g. `incident-response-webhook-staging.example.com`. The Slack endpoints live under the `/slack` path prefix (the chart's `ingress.slackPath`):

- Slash commands → `https://<webhook-host>/slack/commands`
- Interactivity  → `https://<webhook-host>/slack/interactivity`

There is no app-level token and no Socket Mode toggle — leave Socket Mode **off**. Public HTTPS is already terminated in front of the webhook Deployment for the Grafana path: the AWS Load Balancer Controller fronts the `alb`-class Ingress with an ALB that serves the ACM certificate named by `ingress.tls.certificateArn` (or the one it matched to `ingress.host`). The Slack endpoints ride the same Ingress and the same certificate — Slack requires HTTPS on a Request URL, so the certificate has to cover the host before you save these. They are verified with the signing secret instead of the Grafana HMAC.

## 4. Interactivity & Shortcuts

Left nav → **Interactivity & Shortcuts** → toggle **Interactivity** on.

This toggle must be ON for Block Kit button clicks to flow back to the app. IncidentResponse uses Block Kit buttons for:
- Statuspage draft **Approve & Publish** / **Edit** (the approval gate — *this is critical*; the clicking human is recorded as the approver)
- Pulse-rating 1–5 stars on `/incident-response resolve`
- Nudge **Silence** action

**Request URL:** `https://<webhook-host>/slack/interactivity`. Slack POSTs each interaction here; the webhook Deployment verifies the signing secret, acks immediately, and posts the result to the interaction's `response_url`.

Save.

## 5. Slash Commands

Left nav → **Slash Commands** → **Create New Command**.

- **Command:** `/incident-response`
- **Request URL:** `https://<webhook-host>/slack/commands`
- **Short Description:** `IncidentResponse incident commander`
- **Usage Hint:** `help | status | resolve | silence | checklist`
- **Escape channels, users, and links:** leave unchecked.

Save.

Repeat for any other top-level slash commands you add later. Subcommands (`/incident-response status draft`, `/incident-response resolve`, etc.) are parsed inside IncidentResponse's `CommandRegistry`; Slack only needs to know about `/incident-response` itself.

## 6. Basic Information — Signing Secret

Left nav → **Basic Information** → **App Credentials** → **Signing Secret**. Click **Show** → copy.

Slack signs every inbound request (slash commands, interactivity) with HMAC-SHA256 using this secret (the v0 scheme: `v0=HMAC(v0:{timestamp}:{rawBody})`). `src/handlers/slack-signature.ts` verifies it — timing-safe compare, 5-minute replay window — before any handler runs. Without a matching `SLACK_SIGNING_SECRET`, the webhook returns 401 for every Slack request.

## 7. Install to Workspace

Left nav → **Install App** → **Install to Workspace**. Review the scope request → **Allow**.

Slack returns:
- **Bot User OAuth Token** — starts with `xoxb-`. This is the token IncidentResponse's `@slack/web-api` uses for every API call (`chat.postMessage`, `conversations.create`, etc.).

Copy it.

## 8. Seed both tokens + restart the deployments

You now have two secrets to place:

- `xoxb-…` → `incident-response/{env}/slack/bot-token`
- signing secret (opaque string, no prefix) → `incident-response/{env}/slack/signing-secret`

Edit your populated seed file (`incident-response-secrets.{env}.json`):

```json
{
  "slack/bot-token":      "xoxb-...",
  "slack/signing-secret": "...",
  ...
}
```

Seed + restart both deployments so they pick up the new values (the webhook serves the signed Slack endpoints; the processor holds the outbound bot token):

```bash
npm run seed:{env}
kubectl rollout restart deploy/incident-response-webhook deploy/incident-response-processor -n tenants-incident-response
```

## 9. Verify

In any channel the bot has been added to (add it manually via channel settings → **Integrations** → **Add apps** → search "incident-response"), type:

```
/incident-response help
```

If it responds, the full path is working: Slack → ingress controller → webhook (`/slack/commands`, signature verified) → `CommandRegistry` → the help handler → `response_url` reply. Any error means one of the eight prior steps has a gap.

Common verify failures:

| You see | Means | Fix |
|---|---|---|
| `/incident-response is not a valid command` | Step 5 wasn't done, or the app wasn't reinstalled after step 5 | Go back to Install App → **Reinstall** after adding slash commands |
| Slack shows a dispatch/timeout error | The Request URL is wrong or unreachable, or the signing secret doesn't match (webhook returns 401) | Confirm the URL is `https://<webhook-host>/slack/commands` and reseed `slack/signing-secret`, then `kubectl rollout restart deploy/incident-response-webhook -n tenants-incident-response` |
| Command runs but replies with "Unknown command" | Slash command fired but the subcommand isn't registered in `CommandRegistry` | Type `/incident-response help` — the `help` handler is always registered; if that works, the issue is your subcommand arg |
| `cannot_post_to_channel` in processor logs | Bot isn't in the channel | Add the bot: channel settings → Integrations → Add apps |

## Rotation

Whenever you change scopes or the slash-command definition, Slack requires a **re-install** (yellow banner at the top of the app config page). Re-install rotates the bot token (`xoxb-`). Do the rotation immediately — the old token stops working within minutes:

1. **Install App → Reinstall to Workspace** → copy the new `xoxb-…`.
2. Edit your seed file with the new value.
3. `npm run seed:{env}`.
4. `kubectl rollout restart deploy/incident-response-processor -n tenants-incident-response`.

The signing secret doesn't rotate on reinstall — you only re-seed `slack/bot-token`.

## Separate apps per environment

Create two apps: `IncidentResponse (staging)` and `IncidentResponse (production)`. Reasons:

- **Scope blast radius.** A compromised staging bot token can't do anything to production's workspace. The two apps have distinct tokens by construction.
- **Audit clarity.** Slack's audit log attributes actions to the app; separate apps mean staging drill activity is distinguishable from real production events.
- **Per-workspace install.** If staging lives in a test Slack workspace and production lives in the main workspace, you *must* have separate apps anyway — Slack apps install per-workspace.

Repeat this entire doc for each environment. The seed file for each env holds its own `xoxb-` bot token + signing-secret values, and its own webhook host for the Request URLs.

## Troubleshooting catalogue

See [`docs/troubleshooting.md`](troubleshooting.md) for specific error messages and their fixes — including every Slack-side failure mode observed during IncidentResponse's first staging bring-up.
