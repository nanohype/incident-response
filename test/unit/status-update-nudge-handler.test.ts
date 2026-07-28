/**
 * Unit tests for the STATUS_UPDATE_NUDGE event handler.
 *
 * The handler's whole job is deciding whether to stay quiet. The cases that
 * matter are the ones where it must nudge anyway — a low-confidence answer, an
 * unreadable channel, a classifier that errors — because a swallowed reminder
 * is the expensive failure and it leaves no trace.
 */

import type { WebClient } from "@slack/web-api";
import type { IncidentResponseAI } from "../../src/ai/incident-response-ai.js";
import { __test, makeStatusUpdateNudgeHandler } from "../../src/events/status-update-nudge.js";
import type { NudgeQueueMessage } from "../../src/services/sqs-consumer.js";
import type { AuditWriter } from "../../src/utils/audit.js";

const message: NudgeQueueMessage = {
  type: "STATUS_UPDATE_NUDGE",
  incident_id: "inc-1",
  channel_id: "C123",
};

function harness(opts: {
  messages?: unknown[];
  historyOk?: boolean;
  historyThrows?: boolean;
  classify?: (text: string) => Promise<{ is_status_update: boolean; confidence: number }>;
}) {
  const postMessage = vi.fn().mockResolvedValue({ ok: true });
  const history = opts.historyThrows
    ? vi.fn().mockRejectedValue(new Error("channel_not_found"))
    : vi.fn().mockResolvedValue({
        ok: opts.historyOk ?? true,
        messages: opts.messages ?? [],
      });
  const write = vi.fn().mockResolvedValue(undefined);
  const classifyAsStatusUpdate = vi
    .fn()
    .mockImplementation((text: string) =>
      opts.classify
        ? opts.classify(text)
        : Promise.resolve({ is_status_update: false, confidence: 0 }),
    );

  const handler = makeStatusUpdateNudgeHandler({
    slack: { chat: { postMessage }, conversations: { history } } as unknown as WebClient,
    auditWriter: { write } as unknown as AuditWriter,
    incidentResponseAI: { classifyAsStatusUpdate } as unknown as IncidentResponseAI,
  });
  return { handler, postMessage, history, write, classifyAsStatusUpdate };
}

const human = (ts: string, text: string) => ({ ts, text });

describe("makeStatusUpdateNudgeHandler", () => {
  it("NUDGE-001: suppresses the nudge when a recent message is a confident status update", async () => {
    const h = harness({
      messages: [human("1700000100.0", "Mitigation deployed, error rate back under 1%.")],
      classify: async () => ({ is_status_update: true, confidence: 0.95 }),
    });
    await h.handler(message);

    expect(h.postMessage).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledWith(
      "inc-1",
      "INCIDENT_RESPONSE",
      "STATUS_REMINDER_SUPPRESSED",
      expect.objectContaining({ matched_message_ts: "1700000100.0", confidence: 0.95 }),
    );
  });

  it("NUDGE-002: nudges when the classifier is not confident enough", async () => {
    const h = harness({
      messages: [human("1700000100.0", "might be the cache?")],
      classify: async () => ({ is_status_update: true, confidence: 0.4 }),
    });
    await h.handler(message);

    expect(h.postMessage).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith(
      "inc-1",
      "INCIDENT_RESPONSE",
      "STATUS_REMINDER_SENT",
      expect.objectContaining({ channel_id: "C123" }),
    );
  });

  it("NUDGE-003: nudges when nothing in the window is a status update", async () => {
    const h = harness({ messages: [human("1700000100.0", "on it")] });
    await h.handler(message);
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });

  it("NUDGE-004: nudges when the history call fails — a missed reminder is the costly failure", async () => {
    const h = harness({ historyThrows: true });
    await h.handler(message);
    expect(h.postMessage).toHaveBeenCalledTimes(1);
    expect(h.classifyAsStatusUpdate).not.toHaveBeenCalled();
  });

  it("NUDGE-005: nudges when Slack answers not-ok", async () => {
    const h = harness({ historyOk: false });
    await h.handler(message);
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });

  it("NUDGE-006: nudges when the classifier throws", async () => {
    const h = harness({
      messages: [human("1700000100.0", "deployed the fix")],
      classify: async () => {
        throw new Error("Bedrock down");
      },
    });
    await h.handler(message);
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });

  it("NUDGE-007: never suppresses on its own bot post", async () => {
    // The nudge is itself a channel message. Classifying it would make the
    // feature mute itself permanently after the first reminder.
    const h = harness({
      messages: [{ ts: "1700000100.0", text: "🕒 15-minute status update due", bot_id: "B1" }],
      classify: async () => ({ is_status_update: true, confidence: 0.99 }),
    });
    await h.handler(message);
    expect(h.classifyAsStatusUpdate).not.toHaveBeenCalled();
    expect(h.postMessage).toHaveBeenCalledTimes(1);
  });

  it("NUDGE-008: drops the event when channel_id is missing", async () => {
    const h = harness({});
    await h.handler({ type: "STATUS_UPDATE_NUDGE", incident_id: "inc-1" });
    expect(h.postMessage).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("NUDGE-009: stops classifying once a match is found", async () => {
    const h = harness({
      messages: [
        human("1700000300.0", "mitigation deployed"),
        human("1700000200.0", "older chatter"),
        human("1700000100.0", "even older"),
      ],
      classify: async (text) => ({
        is_status_update: text === "mitigation deployed",
        confidence: 0.9,
      }),
    });
    await h.handler(message);
    expect(h.classifyAsStatusUpdate).toHaveBeenCalledTimes(1);
    expect(h.postMessage).not.toHaveBeenCalled();
  });
});

describe("humanMessages", () => {
  it("NUDGE-010: drops bots and empties, sorts newest first, and caps", () => {
    const out = __test.humanMessages(
      [
        { ts: "3", text: "third" },
        { ts: "5", text: "newest" },
        { ts: "4", text: "  " },
        { ts: "2", text: "bot noise", bot_id: "B1" },
        { ts: "1", text: "oldest" },
        { ts: "6", text: "subtyped bot", subtype: "bot_message" },
      ],
      2,
    );
    expect(out).toEqual([
      { ts: "5", text: "newest" },
      { ts: "3", text: "third" },
    ]);
  });
});
