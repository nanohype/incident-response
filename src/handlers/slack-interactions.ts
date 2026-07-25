/**
 * Slack signed-HTTP interactions — slash commands + Block Kit interactivity.
 *
 * The human Slack surface. Slack POSTs slash commands and interactive actions
 * to the webhook Deployment's Request URLs; `slack-signature.ts` verifies the
 * signing secret, then these handlers dispatch them — slash commands through the
 * `CommandRegistry`, button clicks through the action switch below.
 *
 * The compliance-critical property: `statuspage_approve`
 * calls `approvalGate.approveAndPublish(incident_id, draft_id, body.user.id)`
 * with the CLICKING HUMAN's id as the approver. Publishing a customer-facing
 * status page stays a deterministic, fully-attributed human gesture — it is
 * NOT an MCP tool and never runs on LLM intent. See the approval gate's
 * invariant ("IC must click Approve & Publish in Slack").
 */

import { URLSearchParams } from "node:url";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { WebClient } from "@slack/web-api";
import {
  type CommandRegistry,
  SlashCommandArgsSchema,
  SlashCommandTextSchema,
} from "../services/command-registry.js";
import type { StatuspageApprovalGate } from "../services/statuspage-approval-gate.js";
import type { RespondFn, SlackRespondArguments, SlashCommand } from "../types/slack.js";
import type { AuditWriter } from "../utils/audit.js";
import { stringifyError } from "../utils/errors.js";
import { HttpClient } from "../utils/http-client.js";
import { resolveIncidentByChannel } from "../utils/incident-lookup.js";
import { logger } from "../utils/logger.js";

// Subcommands that require an active war-room context. `help` does not — it
// should work anywhere in the workspace.
export const CHANNEL_SCOPED_COMMANDS = new Set(["status", "checklist", "silence", "resolve"]);

export type PulseRating = 1 | 2 | 3 | 4 | 5;

/** Poster for a Slack `response_url`. Injectable so tests never hit the wire. */
export type ResponseUrlPoster = (
  responseUrl: string,
  message: SlackRespondArguments,
) => Promise<void>;

export interface SlackInteractionDeps {
  commandRegistry: CommandRegistry;
  approvalGate: Pick<StatuspageApprovalGate, "approveAndPublish" | "getDraft" | "reviseDraft">;
  auditWriter: Pick<AuditWriter, "write">;
  dynamoDb: DynamoDBDocumentClient;
  incidentsTableName: string;
  slack: WebClient;
  respondTo: ResponseUrlPoster;
}

// ── Block Kit interaction payload (the subset we dispatch on) ─────────────────
interface BlockAction {
  action_id: string;
  value?: string;
  block_id?: string;
}
export interface InteractionPayload {
  type: string;
  user: { id: string };
  channel?: { id: string };
  trigger_id?: string;
  response_url?: string;
  actions?: BlockAction[];
  // A modal submission carries no `actions` — the payload is the view itself,
  // keyed by the callback_id the modal was opened with.
  view?: {
    callback_id?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
}

/**
 * The default `response_url` poster. Slack accepts a deferred reply as a POST
 * to the interaction's `response_url`; this routes through `HttpClient`
 * (timeout + retry caps + tracing) so it honours the app's "no bare fetch"
 * discipline.
 */
export const postToResponseUrl: ResponseUrlPoster = async (responseUrl, message) => {
  const client = new HttpClient({
    clientName: "slack.response_url",
    baseUrl: responseUrl,
    timeoutMs: 3000,
    maxRetries: 1,
  });
  await client.post("", message);
};

/** Build a `respond` bound to one interaction's `response_url`. */
function makeResponder(deps: SlackInteractionDeps, responseUrl: string): RespondFn {
  return (message) =>
    deps.respondTo(responseUrl, typeof message === "string" ? { text: message } : message);
}

/** Parse a Slack slash-command `application/x-www-form-urlencoded` body. */
export function parseSlashCommand(rawBody: string): SlashCommand {
  const p = new URLSearchParams(rawBody);
  return {
    command: p.get("command") ?? "",
    text: p.get("text") ?? "",
    user_id: p.get("user_id") ?? "",
    channel_id: p.get("channel_id") ?? "",
    team_id: p.get("team_id") ?? "",
    response_url: p.get("response_url") ?? "",
    trigger_id: p.get("trigger_id") ?? "",
  };
}

/**
 * Parse a Slack interactivity body. Slack sends a single `payload` field whose
 * value is URL-encoded JSON.
 */
export function parseInteraction(rawBody: string): InteractionPayload {
  const raw = new URLSearchParams(rawBody).get("payload") ?? "";
  return JSON.parse(raw) as InteractionPayload;
}

/**
 * Dispatch a slash command: validate text/args, audit the receipt, resolve
 * channel → canonical incident, then hand off to the CommandRegistry. Threads
 * `user_id` attribution and replies via the deferred `response_url` contract.
 */
export async function handleSlashCommand(
  deps: SlackInteractionDeps,
  command: SlashCommand,
): Promise<void> {
  const respond = makeResponder(deps, command.response_url);

  const textParse = SlashCommandTextSchema.safeParse(command.text);
  if (!textParse.success) {
    await respond({ text: "❌ Command text too long. Keep it under 500 characters." });
    return;
  }
  const tokens = textParse.data.trim().split(/\s+/);
  const argsParse = SlashCommandArgsSchema.safeParse(tokens.slice(1));
  if (!argsParse.success) {
    await respond({
      text: "❌ Too many or oversized arguments. Keep it to 10 tokens, 100 chars each.",
    });
    return;
  }
  const subCommand = tokens[0] ?? "";
  const args = argsParse.data;
  await deps.auditWriter.write(command.channel_id, command.user_id, "SLASH_COMMAND_RECEIVED", {
    command: subCommand,
    args,
    channel_id: command.channel_id,
  });

  // Resolve the Slack channel back to the canonical incident_id via the
  // slack-channel-index GSI. Channel-scoped commands require this; `help` and
  // anything unknown run with the channel_id fallback so the dispatcher still
  // reaches the handler and produces the right reply.
  let resolvedIncidentId = command.channel_id;
  if (CHANNEL_SCOPED_COMMANDS.has(subCommand.toLowerCase())) {
    try {
      const incident = await resolveIncidentByChannel(
        deps.dynamoDb,
        deps.incidentsTableName,
        command.channel_id,
      );
      if (incident) {
        resolvedIncidentId = incident.incident_id;
      } else {
        await respond({
          text: "No active incident found for this channel. Start one via Grafana OnCall.",
        });
        return;
      }
    } catch (err) {
      logger.error(
        { channel_id: command.channel_id, error: stringifyError(err) },
        "Failed to resolve incident by channel",
      );
      await respond({ text: "❌ Internal error resolving incident for this channel. Check logs." });
      return;
    }
  }

  await deps.commandRegistry.dispatch({
    subCommand,
    args,
    incidentId: resolvedIncidentId,
    userId: command.user_id,
    channelId: command.channel_id,
    rawCommand: command,
    slack: deps.slack,
    respond,
  });
}

/**
 * Handle a modal submission. Today that is only the status-page draft editor,
 * keyed by the `statuspage_edit_submit:<incident>:<draft>` callback_id the modal
 * was opened with.
 *
 * The IC's edit lands on a customer-facing message on the compliance-gated
 * publish path, so it is a first-class attributed gesture, not a UI nicety: the
 * revision goes through the approval gate (which rehashes the body and writes an
 * awaited audit event), and the draft stays PENDING_APPROVAL so the deliberate
 * Approve & Publish click is still required afterwards.
 */
async function handleViewSubmission(
  deps: SlackInteractionDeps,
  payload: InteractionPayload,
): Promise<void> {
  const callbackId = payload.view?.callback_id ?? "";
  if (!callbackId.startsWith("statuspage_edit_submit:")) {
    logger.warn({ callback_id: callbackId }, "Unhandled view_submission callback_id");
    return;
  }

  const [, incidentId, draftId] = callbackId.split(":");
  const newBody = payload.view?.state?.values?.draft_body?.draft_body_input?.value ?? "";
  const userId = payload.user.id;

  if (!incidentId || !draftId) {
    logger.error({ callback_id: callbackId }, "Malformed statuspage edit callback_id");
    return;
  }
  if (newBody.trim() === "") {
    // Slack has already closed the modal by the time we run, so there is no
    // response_action to return — refusing loudly in the log beats silently
    // blanking a customer-facing message.
    logger.warn(
      { incident_id: incidentId, draft_id: draftId, user_id: userId },
      "Refusing to save an empty status page draft",
    );
    return;
  }

  try {
    const { previous_body_sha256, body_sha256 } = await deps.approvalGate.reviseDraft(
      incidentId,
      draftId,
      newBody,
      userId,
    );
    logger.info(
      {
        incident_id: incidentId,
        draft_id: draftId,
        user_id: userId,
        previous_body_sha256,
        body_sha256,
      },
      "Status page draft revised; still pending approval",
    );
  } catch (err) {
    // "Silent stubs are bugs" cuts both ways: a failed save must not look like a
    // successful one. The modal is already gone, so the log and the unchanged
    // draft in the channel are what the IC has to go on.
    logger.error(
      { incident_id: incidentId, draft_id: draftId, error: stringifyError(err) },
      "Failed to save status page draft revision",
    );
  }
}

/**
 * Dispatch a Block Kit interaction (approve / edit / silence / pulse). Every
 * gesture is attributed to `payload.user.id` — the human who clicked.
 */
export async function handleInteraction(
  deps: SlackInteractionDeps,
  payload: InteractionPayload,
): Promise<void> {
  if (payload.type === "view_submission") {
    await handleViewSubmission(deps, payload);
    return;
  }

  const action = payload.actions?.[0];
  if (!action) return;
  const userId = payload.user.id;
  const responseUrl = payload.response_url ?? "";
  const respond = makeResponder(deps, responseUrl);

  if (action.action_id === "statuspage_approve") {
    const { incident_id, draft_id } = JSON.parse(action.value ?? "{}") as {
      incident_id: string;
      draft_id: string;
    };
    try {
      // The clicking human's id is the approver — threaded into every audit
      // write by the gate. This is the ONLY publish path and it never runs on
      // LLM intent.
      const result = await deps.approvalGate.approveAndPublish(incident_id, draft_id, userId);
      await respond({
        text: `✅ Status page published by <@${userId}>. <${result.shortlink}|View on status page>`,
        replace_original: true,
      });
    } catch (err) {
      logger.error(
        { incident_id, draft_id, error: stringifyError(err) },
        "Status page approval failed",
      );
      await respond({
        text: `❌ Failed to publish status page: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`,
      });
    }
    return;
  }

  if (action.action_id === "statuspage_edit") {
    const { incident_id, draft_id } = JSON.parse(action.value ?? "{}") as {
      incident_id: string;
      draft_id: string;
    };
    // Prefill with the draft as it stands. A modal that opens on placeholder
    // text invites the IC to retype a customer-facing message from memory —
    // and whatever they type replaces the real one wholesale.
    const existing = await deps.approvalGate.getDraft(incident_id, draft_id);
    if (!existing) {
      await respond({
        response_type: "ephemeral",
        text: `Draft \`${draft_id}\` no longer exists for this incident.`,
      });
      return;
    }
    if (existing.status !== "PENDING_APPROVAL") {
      await respond({
        response_type: "ephemeral",
        text: `Draft \`${draft_id}\` is ${existing.status.toLowerCase()} and can no longer be edited.`,
      });
      return;
    }
    await deps.slack.views.open({
      trigger_id: payload.trigger_id ?? "",
      view: {
        type: "modal",
        callback_id: `statuspage_edit_submit:${incident_id}:${draft_id}`,
        title: { type: "plain_text", text: "Edit Status Page Draft" },
        submit: { type: "plain_text", text: "Save & Re-Review" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "draft_body",
            element: {
              type: "plain_text_input",
              action_id: "draft_body_input",
              multiline: true,
              initial_value: existing.body,
            },
            label: { type: "plain_text", text: "Status Page Message" },
          },
        ],
      },
    });
    return;
  }

  if (action.action_id === "silence_reminders") {
    logger.info(
      { channel_id: payload.channel?.id ?? "", user_id: userId },
      "IC silenced reminders via button",
    );
    return;
  }

  const pulseMatch = /^pulse_rate_([1-5])$/.exec(action.action_id);
  if (pulseMatch) {
    const rating = Number.parseInt(pulseMatch[1]!, 10) as PulseRating;
    const { incident_id } = JSON.parse(action.value ?? "{}") as { incident_id: string };
    await deps.auditWriter.write(incident_id, userId, "IC_RATED", {
      rating,
      rated_at: new Date().toISOString(),
    });
    await respond({
      text: `${"⭐".repeat(rating)} Thank you! Your rating has been recorded.`,
      replace_original: true,
    });
    logger.info({ incident_id, user_id: userId, rating }, "IC pulse rating recorded");
    return;
  }

  logger.warn({ action_id: action.action_id, user_id: userId }, "Unhandled Slack interaction");
}
