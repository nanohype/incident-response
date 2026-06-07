# Slack app setup

IncidentResponse talks to Slack via a custom Slack app running in **socket mode** (no inbound HTTPS endpoint needed — Slack pushes events to the app over a long-lived WebSocket). You need one Slack app per environment (staging + production should have separate apps pointing at separate workspaces).

This doc is a single-pass walkthrough from "blank account at api.slack.com" to "`/incident-response help` works in your workspace". Estimated time: 15 minutes.

## Prerequisites

- A Slack workspace where you're a **workspace Owner or Admin** (you need permission to install apps + create app-level tokens).
- The `incident-response/<env>/*` Secrets Manager path available for this environment (so you have somewhere to seed the tokens). The `landing-zone incident-response-platform` substrate + the seeder set this up.

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

## 3. Socket Mode + app-level token

Left nav → **Socket Mode** → toggle **Enable Socket Mode** on.

Slack will prompt to generate an **app-level token** (starts with `xapp-`). Give it a descriptive name (`incident-response-staging-socket`) and grant exactly one scope: `connections:write`. No other scopes on the app-level token.

This token is distinct from the bot token (`xoxb-`) — the app-level token establishes the WebSocket connection; the bot token authenticates API calls. You'll seed both separately. Copy the `xapp-…` value now (Slack won't show it again).

**Why socket mode:** the processor Deployment has no public HTTP surface. Socket mode lets Slack push events via an outbound-initiated WebSocket — no ingress, no certificate management for the Slack-side traffic. The webhook Deployment for Grafana OnCall is a separate path (public ingress behind ingress-nginx) and doesn't use socket mode.

## 4. Interactivity & Shortcuts

Left nav → **Interactivity & Shortcuts** → toggle **Interactivity** on.

Slack requires this toggle ON for Block Kit button clicks to flow back to the app. IncidentResponse uses Block Kit buttons for:
- Statuspage draft **Approve & Publish** / **Reject** (the approval gate — *this is critical*)
- Pulse-rating 1–5 stars on `/incident-response resolve`
- Nudge **Silence** action

**Request URL:** leave blank. Socket mode handles the transport; Slack's UI requires the toggle to be ON but ignores the URL when socket mode is active.

Save.

## 5. Slash Commands

Left nav → **Slash Commands** → **Create New Command**.

- **Command:** `/incident-response`
- **Request URL:** required by the UI, unused in socket mode. Put any valid HTTPS URL — `https://example.com/slack/commands` is fine. Slack ignores it when socket mode delivers the event.
- **Short Description:** `IncidentResponse incident commander`
- **Usage Hint:** `help | status | resolve | silence | checklist`
- **Escape channels, users, and links:** leave unchecked.

Save.

Repeat for any other top-level slash commands you add later. Subcommands (`/incident-response status draft`, `/incident-response resolve`, etc.) are parsed inside IncidentResponse's `CommandRegistry`; Slack only needs to know about `/incident-response` itself.

## 6. Basic Information — Signing Secret

Left nav → **Basic Information** → **App Credentials** → **Signing Secret**. Click **Show** → copy.

Slack signs every inbound request (socket-mode events, slash commands, interactivity) with HMAC-SHA256 using this secret. Bolt verifies the signature before invoking handlers. Without a matching signing secret in IncidentResponse's config, Bolt rejects every event as forged.

## 7. Install to Workspace

Left nav → **Install App** → **Install to Workspace**. Review the scope request → **Allow**.

Slack returns:
- **Bot User OAuth Token** — starts with `xoxb-`. This is the token IncidentResponse's `@slack/web-api` uses for every API call (`chat.postMessage`, `conversations.create`, etc.).

Copy it.

## 8. Seed all three tokens + restart the processor

You now have three secrets to place:

- `xoxb-…` → `incident-response/{env}/slack/bot-token`
- `xapp-…` → `incident-response/{env}/slack/app-token`
- signing secret (opaque string, no prefix) → `incident-response/{env}/slack/signing-secret`

Edit your populated seed file (`incident-response-secrets.{env}.json`):

```json
{
  "slack/bot-token":      "xoxb-...",
  "slack/signing-secret": "...",
  "slack/app-token":      "xapp-...",
  ...
}
```

Seed + restart the processor so it picks up the new values:

```bash
npm run seed:{env}
kubectl rollout restart deploy/incident-response-processor -n tenants-protohype
```

## 9. Verify

In any channel the bot has been added to (add it manually via channel settings → **Integrations** → **Add apps** → search "incident-response"), type:

```
/incident-response help
```

If it responds, the full path is working: Slack ↔ socket-mode tunnel ↔ Bolt ↔ `CommandRegistry` ↔ the help handler. Any error means one of the eight prior steps has a gap.

Common verify failures:

| You see | Means | Fix |
|---|---|---|
| `/incident-response is not a valid command` | Step 5 wasn't done, or the app wasn't reinstalled after step 5 | Go back to Install App → **Reinstall** after adding slash commands |
| Command runs but replies with "Unknown command" | Slash command fired but the subcommand isn't registered in `CommandRegistry` | Type `/incident-response help` — the `help` handler is always registered; if that works, the issue is your subcommand arg |
| Nothing happens (no reply, no error) | Bot token was rotated (step 7 re-install) but the running pod still has the old token | Reseed + `kubectl rollout restart deploy/incident-response-processor -n tenants-protohype` |
| `cannot_post_to_channel` in processor logs | Bot isn't in the channel | Add the bot: channel settings → Integrations → Add apps |

## Rotation

Whenever you change scopes or the slash-command definition, Slack requires a **re-install** (yellow banner at the top of the app config page). Re-install rotates the bot token (`xoxb-`). Do the rotation immediately — the old token stops working within minutes:

1. **Install App → Reinstall to Workspace** → copy the new `xoxb-…`.
2. Edit your seed file with the new value.
3. `npm run seed:{env}`.
4. `kubectl rollout restart deploy/incident-response-processor -n tenants-protohype`.

The signing secret and app-level token don't rotate on reinstall — you only re-seed `slack/bot-token`.

## Separate apps per environment

Create two apps: `IncidentResponse (staging)` and `IncidentResponse (production)`. Reasons:

- **Scope blast radius.** A compromised staging bot token can't do anything to production's workspace. The two apps have distinct tokens by construction.
- **Audit clarity.** Slack's audit log attributes actions to the app; separate apps mean staging drill activity is distinguishable from real production events.
- **Per-workspace install.** If staging lives in a test Slack workspace and production lives in the main workspace, you *must* have separate apps anyway — Slack apps install per-workspace.

Repeat this entire doc for each environment. The seed file for each env holds its own `xoxb-` / `xapp-` / signing-secret values.

## Troubleshooting catalogue

See [`docs/troubleshooting.md`](troubleshooting.md) for specific error messages and their fixes — including every Slack-side failure mode observed during IncidentResponse's first staging bring-up.
