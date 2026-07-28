/**
 * SQS consumer tests.
 *
 * The header calls this loop "DLQ-safe (no delete on processing failure)", and
 * that one sentence is the whole reliability story for incident ingestion: a
 * message is deleted only after its handler resolves, so a crash mid-handler
 * means SQS redelivers rather than the alert vanishing. Moving the delete out
 * of the success path — a plausible tidy-up — would silently drop every failed
 * alert with the suite still green.
 *
 * The AWS client is injected; everything above it (poll ordering, poison-pill
 * handling, trace-context continuation, the delete decision) runs for real.
 */

import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type IncidentQueueMessage,
  type NudgeQueueMessage,
  SqsConsumer,
} from "../../src/services/sqs-consumer.js";

const INCIDENT_Q = "https://sqs.us-east-1.amazonaws.com/111111111111/incident-events";
const NUDGE_Q = "https://sqs.us-east-1.amazonaws.com/111111111111/nudge-events";

interface FakeSqs {
  client: SQSClient;
  send: ReturnType<typeof vi.fn>;
  deletedHandles: string[];
  receiveCalls: string[];
}

/** A client that serves each queue's messages once, then nothing. */
function fakeSqs(queues: Record<string, Array<Record<string, unknown>>>): FakeSqs {
  const remaining = { ...queues };
  const deletedHandles: string[] = [];
  const receiveCalls: string[] = [];

  const send = vi.fn(async (command: unknown) => {
    if (command instanceof ReceiveMessageCommand) {
      const url = command.input.QueueUrl as string;
      receiveCalls.push(url);
      const messages = remaining[url] ?? [];
      remaining[url] = [];
      return { Messages: messages };
    }
    if (command instanceof DeleteMessageCommand) {
      deletedHandles.push(command.input.ReceiptHandle as string);
      return {};
    }
    return {};
  });

  return { client: { send } as unknown as SQSClient, send, deletedHandles, receiveCalls };
}

function message(body: unknown, receiptHandle: string, attributes?: Record<string, unknown>) {
  return {
    Body: typeof body === "string" ? body : JSON.stringify(body),
    ReceiptHandle: receiptHandle,
    Attributes: attributes,
  };
}

/**
 * Run exactly one poll cycle: start the loop, let the microtasks and the
 * poll interval drain, then stop. The loop is a `while (running)` around an
 * awaited poll, so fake timers keep it from spinning.
 */
async function pumpOnce(consumer: SqsConsumer) {
  consumer.start();
  await vi.advanceTimersByTimeAsync(0);
  consumer.stop();
  await vi.advanceTimersByTimeAsync(2000);
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe("the DLQ contract", () => {
  it("deletes a message only after its handler resolves", async () => {
    const sqs = fakeSqs({
      [INCIDENT_Q]: [message({ type: "ALERT_RECEIVED", payload: {} }, "rh-ok")],
    });
    const order: string[] = [];
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      async () => {
        order.push("handled");
      },
      async () => {},
      1000,
      sqs.client,
    );

    await pumpOnce(consumer);

    expect(order).toEqual(["handled"]);
    expect(sqs.deletedHandles).toEqual(["rh-ok"]);
  });

  it("leaves a message on the queue when its handler throws", async () => {
    // This is the DLQ path. Deleting here would acknowledge an alert that was
    // never processed — the incident simply never happens, with no error
    // anywhere but a log line.
    const sqs = fakeSqs({
      [INCIDENT_Q]: [message({ type: "ALERT_RECEIVED", payload: {} }, "rh-failed")],
    });
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      async () => {
        throw new Error("DynamoDB unavailable");
      },
      async () => {},
      1000,
      sqs.client,
    );

    await pumpOnce(consumer);

    expect(sqs.deletedHandles).toEqual([]);
  });

  it("keeps processing the rest of a batch after one message fails", async () => {
    const sqs = fakeSqs({
      [INCIDENT_Q]: [
        message({ type: "ALERT_RECEIVED", payload: { id: "bad" } }, "rh-bad"),
        message({ type: "ALERT_RECEIVED", payload: { id: "good" } }, "rh-good"),
      ],
    });
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      async (msg: IncidentQueueMessage) => {
        if ((msg.payload as { id?: string }).id === "bad") throw new Error("boom");
      },
      async () => {},
      1000,
      sqs.client,
    );

    await pumpOnce(consumer);

    // The failed one stays for redelivery; the healthy one is acknowledged.
    expect(sqs.deletedHandles).toEqual(["rh-good"]);
  });
});

describe("poison messages", () => {
  it("drops an unparseable body instead of redelivering it forever", async () => {
    // A body that will never parse cannot succeed on retry. Leaving it would
    // recycle it until the redrive policy gives up, delaying every message
    // behind it in the meantime.
    const sqs = fakeSqs({ [INCIDENT_Q]: [message("{not json", "rh-poison")] });
    const handler = vi.fn(async () => {});
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      handler,
      async () => {},
      1000,
      sqs.client,
    );

    await pumpOnce(consumer);

    expect(handler).not.toHaveBeenCalled();
    expect(sqs.deletedHandles).toEqual(["rh-poison"]);
  });

  it("drops a message with no body", async () => {
    const sqs = fakeSqs({ [INCIDENT_Q]: [{ ReceiptHandle: "rh-empty" }] });
    const handler = vi.fn(async () => {});
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      handler,
      async () => {},
      1000,
      sqs.client,
    );

    await pumpOnce(consumer);

    expect(handler).not.toHaveBeenCalled();
    expect(sqs.deletedHandles).toEqual(["rh-empty"]);
  });
});

describe("both queues", () => {
  it("polls the incident and nudge queues on every cycle", async () => {
    const sqs = fakeSqs({});
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      async () => {},
      async () => {},
      1000,
      sqs.client,
    );

    await pumpOnce(consumer);

    expect(sqs.receiveCalls).toContain(INCIDENT_Q);
    expect(sqs.receiveCalls).toContain(NUDGE_Q);
  });

  it("routes each queue's messages to its own handler", async () => {
    const sqs = fakeSqs({
      [INCIDENT_Q]: [message({ type: "ALERT_RECEIVED", payload: {} }, "rh-i")],
      [NUDGE_Q]: [message({ type: "STATUS_UPDATE_NUDGE", incident_id: "INC-1" }, "rh-n")],
    });
    const onIncident = vi.fn(async () => {});
    const onNudge = vi.fn(async (msg: NudgeQueueMessage) => {
      expect(msg.incident_id).toBe("INC-1");
    });
    const consumer = new SqsConsumer(INCIDENT_Q, NUDGE_Q, onIncident, onNudge, 1000, sqs.client);

    await pumpOnce(consumer);

    expect(onIncident).toHaveBeenCalledTimes(1);
    expect(onNudge).toHaveBeenCalledTimes(1);
  });
});

describe("resilience", () => {
  it("survives a receive failure and keeps the loop alive", async () => {
    // A transient SQS error must not end the consumer. The pod stays up and
    // the next cycle retries; throwing here would take the processor down on
    // a blip and lose the in-flight alerts with it.
    let calls = 0;
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) {
        if (++calls <= 2) throw new Error("throttled");
        return { Messages: [] };
      }
      return {};
    });
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      async () => {},
      async () => {},
      10,
      { send } as unknown as SQSClient,
    );

    consumer.start();
    await vi.advanceTimersByTimeAsync(50);
    consumer.stop();
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toBeGreaterThan(2);
  });

  it("tolerates a delete failure without losing the loop", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) {
        return command.input.QueueUrl === INCIDENT_Q
          ? { Messages: [message({ type: "ALERT_RECEIVED", payload: {} }, "rh-1")] }
          : { Messages: [] };
      }
      if (command instanceof DeleteMessageCommand) throw new Error("delete failed");
      return {};
    });
    const handler = vi.fn(async () => {});
    const consumer = new SqsConsumer(INCIDENT_Q, NUDGE_Q, handler, async () => {}, 1000, {
      send,
    } as unknown as SQSClient);

    await expect(pumpOnce(consumer)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalled();
  });

  it("stops polling after stop()", async () => {
    const sqs = fakeSqs({});
    const consumer = new SqsConsumer(
      INCIDENT_Q,
      NUDGE_Q,
      async () => {},
      async () => {},
      10,
      sqs.client,
    );

    consumer.start();
    await vi.advanceTimersByTimeAsync(30);
    consumer.stop();
    await vi.advanceTimersByTimeAsync(30);
    const afterStop = sqs.receiveCalls.length;
    await vi.advanceTimersByTimeAsync(200);

    expect(sqs.receiveCalls.length).toBe(afterStop);
  });
});
