/**
 * STATUS_UPDATE_NUDGE — EventBridge Scheduler fires every 15 min; nudge the IC
 * for a status update, unless they have already posted one.
 *
 * The scheduler has no idea what happened in the channel, so an unconditional
 * nudge asks an IC who posted an update ninety seconds ago to post another one.
 * During a P1 that is noise arriving on the one channel that must stay
 * readable, and the usual response to a bot that cries wolf is to mute it —
 * which loses the reminder for the incident where it mattered.
 *
 * So before nudging, read what was said in the window and ask the classifier
 * whether any of it was a status update.
 *
 * Failure leans toward nudging. A history call that times out, a classifier
 * that errors, a channel the bot cannot read — every one of those posts the
 * nudge anyway. A redundant reminder costs an IC two seconds; a swallowed one
 * costs a customer-facing update nobody sent.
 */

import type { WebClient } from "@slack/web-api";
import type { IncidentResponseAI } from "../ai/incident-response-ai.js";
import type { EventHandler } from "../services/event-registry.js";
import { buildNudgeBlocks } from "../services/slack-blocks.js";
import type { NudgeQueueMessage } from "../services/sqs-consumer.js";
import type { AuditWriter } from "../utils/audit.js";
import { stringifyError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { withTimeoutOrDefault } from "../utils/with-timeout.js";

/** Matches the scheduler's cadence — the window the nudge is asking about. */
const DEFAULT_WINDOW_MINUTES = 15;

/**
 * Confidence below this is treated as "not sure", and not-sure nudges. The
 * classifier returns 0 on every failure path, so this also keeps a degraded
 * classifier from silently suppressing every reminder.
 */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Newest-first cap on classification calls. Each one is a Haiku round trip, per
 * nudge, per open incident — an unbounded war room would otherwise turn one
 * scheduler tick into a hundred inference calls. The IC's update is almost
 * always among the last few messages.
 */
const DEFAULT_MAX_MESSAGES = 8;

interface ChannelMessage {
  ts: string;
  text: string;
}

/**
 * Human messages in the window, newest first, capped.
 *
 * Bot posts are dropped — the nudge itself is a bot post, and classifying the
 * bot's own "status update due" prompt as a status update would make the
 * feature suppress itself forever after the first nudge.
 */
function humanMessages(
  raw: Array<{ ts?: string; text?: string; bot_id?: string; subtype?: string }>,
  cap: number,
): ChannelMessage[] {
  return raw
    .filter((m) => !m.bot_id && m.subtype !== "bot_message")
    .filter((m): m is { ts: string; text: string } => Boolean(m.ts && m.text?.trim()))
    .sort((a, b) => Number(b.ts) - Number(a.ts))
    .slice(0, cap)
    .map((m) => ({ ts: m.ts, text: m.text }));
}

export function makeStatusUpdateNudgeHandler(deps: {
  slack: WebClient;
  auditWriter: AuditWriter;
  incidentResponseAI: IncidentResponseAI;
  windowMinutes?: number;
  confidenceThreshold?: number;
  maxMessages?: number;
}): EventHandler<NudgeQueueMessage> {
  const windowMinutes = deps.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const threshold = deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const cap = deps.maxMessages ?? DEFAULT_MAX_MESSAGES;

  return async (message) => {
    if (!message.channel_id) {
      logger.warn(
        { incident_id: message.incident_id },
        "Nudge event missing channel_id — dropping",
      );
      return;
    }
    const channelId = message.channel_id;
    const oldest = String((Date.now() - windowMinutes * 60_000) / 1000);

    const found = await findRecentStatusUpdate({
      slack: deps.slack,
      ai: deps.incidentResponseAI,
      channelId,
      incidentId: message.incident_id,
      oldest,
      threshold,
      cap,
    });

    if (found) {
      logger.info(
        {
          incident_id: message.incident_id,
          matched_message_ts: found.ts,
          confidence: found.confidence,
        },
        "Status update already posted in the window — suppressing the nudge",
      );
      await deps.auditWriter.write(
        message.incident_id,
        "INCIDENT_RESPONSE",
        "STATUS_REMINDER_SUPPRESSED",
        {
          channel_id: channelId,
          suppressed_at: new Date().toISOString(),
          window_minutes: windowMinutes,
          matched_message_ts: found.ts,
          confidence: found.confidence,
        },
      );
      return;
    }

    await withTimeoutOrDefault(
      deps.slack.chat.postMessage({
        channel: channelId,
        blocks: buildNudgeBlocks(),
        text: "🕒 15-minute status update due",
      }),
      7500,
      "slack.chat.postMessage:nudge",
      undefined,
      message.incident_id,
    );
    await deps.auditWriter.write(message.incident_id, "INCIDENT_RESPONSE", "STATUS_REMINDER_SENT", {
      channel_id: channelId,
      sent_at: new Date().toISOString(),
    });
  };
}

/**
 * The newest human message in the window the classifier calls a status update,
 * or null. Returns null on every failure so the caller nudges — see the module
 * header on why this leans that way.
 */
async function findRecentStatusUpdate(args: {
  slack: WebClient;
  ai: IncidentResponseAI;
  channelId: string;
  incidentId: string;
  oldest: string;
  threshold: number;
  cap: number;
}): Promise<{ ts: string; confidence: number } | null> {
  const history = await withTimeoutOrDefault(
    args.slack.conversations.history({
      channel: args.channelId,
      oldest: args.oldest,
      limit: 50,
    }),
    7500,
    "slack.conversations.history:nudge",
    undefined,
    args.incidentId,
  );

  if (!history?.ok || !Array.isArray(history.messages)) {
    logger.warn(
      { incident_id: args.incidentId },
      "Could not read channel history — nudging without checking for a recent update",
    );
    return null;
  }

  const candidates = humanMessages(history.messages, args.cap);
  for (const m of candidates) {
    try {
      const result = await args.ai.classifyAsStatusUpdate(m.text, args.incidentId);
      if (result.is_status_update && result.confidence >= args.threshold) {
        return { ts: m.ts, confidence: result.confidence };
      }
    } catch (err) {
      // classifyAsStatusUpdate already swallows its own failures; this guards
      // the unexpected. Either way, an unclassifiable message is not evidence
      // that an update was posted.
      logger.warn(
        { incident_id: args.incidentId, error: stringifyError(err) },
        "Classifying a channel message failed — treating it as not a status update",
      );
    }
  }
  return null;
}

export const __test = { humanMessages };
