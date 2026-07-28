/**
 * NudgeScheduler tests.
 *
 * Every method here swallows its errors on purpose — a scheduling failure must
 * not take down incident creation. That is the right call and it is also why
 * this module needed tests more than most: when nothing throws, nothing fails,
 * and a rule that is never created looks exactly like a rule that works until
 * the fifteen minutes pass and no nudge arrives.
 *
 * Two behaviors carry the most weight. The schedule name is derived from an
 * incident id that comes from an external alert payload, and an invalid name
 * is rejected by EventBridge — into the swallow. And `pauseNudge` uses
 * UpdateSchedule, which is a full replace, so it has to carry the existing
 * expression, window and target forward or silencing an IC quietly rewrites
 * the schedule into something else.
 */

import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  ScheduleState,
  type SchedulerClient,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { describe, expect, it, vi } from "vitest";
import { NudgeScheduler } from "../../src/services/nudge-scheduler.js";

const ROLE_ARN = "arn:aws:iam::111111111111:role/incident-response-scheduler";
const QUEUE_ARN = "arn:aws:sqs:us-east-1:111111111111:incident-response-nudges";
const GROUP = "incident-response-production";

function scheduler(responder?: (command: unknown) => unknown) {
  const send = vi.fn(async (command: unknown) => responder?.(command) ?? {});
  const client = { send } as unknown as SchedulerClient;
  return {
    send,
    make: () => new NudgeScheduler(ROLE_ARN, QUEUE_ARN, "us-east-1", GROUP, client),
  };
}

function inputOf(send: ReturnType<typeof vi.fn>, index = 0) {
  return (send.mock.calls[index][0] as { input: Record<string, unknown> }).input;
}

describe("scheduleNudge", () => {
  it("creates an enabled 15-minute rule targeting the nudge queue", async () => {
    const s = scheduler();
    await s.make().scheduleNudge("INC-2026-001", "C_WARROOM");

    const input = inputOf(s.send);
    expect(s.send.mock.calls[0][0]).toBeInstanceOf(CreateScheduleCommand);
    expect(input.ScheduleExpression).toBe("rate(15 minutes)");
    expect(input.State).toBe(ScheduleState.ENABLED);
    expect(input.GroupName).toBe(GROUP);
    expect(input.Target).toMatchObject({ Arn: QUEUE_ARN, RoleArn: ROLE_ARN });
  });

  it("carries the incident and channel through the target payload", async () => {
    // The nudge handler reads both off the queue message. A missing channel id
    // means the reminder has nowhere to be posted.
    const s = scheduler();
    await s.make().scheduleNudge("INC-2026-001", "C_WARROOM");

    const target = inputOf(s.send).Target as { Input: string };
    expect(JSON.parse(target.Input)).toEqual({
      type: "STATUS_UPDATE_NUDGE",
      incident_id: "INC-2026-001",
      channel_id: "C_WARROOM",
    });
  });

  it("does not throw when the schedule cannot be created", async () => {
    // Incident creation continues without nudges rather than failing outright.
    const s = scheduler(() => {
      throw new Error("AccessDeniedException");
    });
    await expect(s.make().scheduleNudge("INC-1", "C_1")).resolves.toBeUndefined();
  });
});

describe("the schedule name", () => {
  it("is derived from the incident id, so teardown can find it again", async () => {
    const s = scheduler();
    const sched = s.make();
    await sched.scheduleNudge("INC-2026-001", "C_1");
    await sched.deleteNudge("INC-2026-001");

    expect(inputOf(s.send, 0).Name).toBe(inputOf(s.send, 1).Name);
  });

  it("strips characters EventBridge will not accept", async () => {
    // The incident id originates in an external alert payload. An unsanitised
    // slash or space is rejected at CreateSchedule, and that rejection is
    // swallowed — so the nudge silently never fires for that incident.
    const s = scheduler();
    await s.make().scheduleNudge("alert/2026 #42:critical", "C_1");

    expect(String(inputOf(s.send).Name)).toMatch(/^[a-zA-Z0-9-_.]+$/);
  });

  it("stays inside the name length limit for a very long incident id", async () => {
    const s = scheduler();
    await s.make().scheduleNudge("x".repeat(300), "C_1");

    expect(String(inputOf(s.send).Name).length).toBeLessThanOrEqual(64);
  });
});

describe("deleteNudge", () => {
  it("deletes the rule from the configured group", async () => {
    const s = scheduler();
    await s.make().deleteNudge("INC-1");

    expect(s.send.mock.calls[0][0]).toBeInstanceOf(DeleteScheduleCommand);
    expect(inputOf(s.send).GroupName).toBe(GROUP);
  });

  it("treats an already-absent rule as done", async () => {
    // Resolving an incident twice, or resolving one whose schedule never got
    // created, is normal. Idempotent teardown keeps it from reading as a fault.
    const s = scheduler(() => {
      throw new ResourceNotFoundException({
        message: "no such schedule",
        Message: "no such schedule",
        $metadata: {},
      });
    });
    await expect(s.make().deleteNudge("INC-1")).resolves.toBeUndefined();
  });

  it("does not throw on any other delete failure", async () => {
    const s = scheduler(() => {
      throw new Error("ThrottlingException");
    });
    await expect(s.make().deleteNudge("INC-1")).resolves.toBeUndefined();
  });
});

describe("pauseNudge", () => {
  const existing = {
    ScheduleExpression: "rate(15 minutes)",
    FlexibleTimeWindow: { Mode: "FLEXIBLE", MaximumWindowInMinutes: 1 },
    Target: { Arn: QUEUE_ARN, RoleArn: ROLE_ARN, Input: '{"type":"STATUS_UPDATE_NUDGE"}' },
  };

  it("disables the rule rather than deleting it", async () => {
    // Silencing is reversible and auditable; deleting would lose the record
    // that a nudge schedule ever existed for this incident.
    const s = scheduler((c) => (c instanceof GetScheduleCommand ? existing : {}));
    await s.make().pauseNudge("INC-1");

    const update = s.send.mock.calls[1][0];
    expect(update).toBeInstanceOf(UpdateScheduleCommand);
    expect(inputOf(s.send, 1).State).toBe(ScheduleState.DISABLED);
  });

  it("carries the existing expression, window and target into the update", async () => {
    // UpdateSchedule is a full replace, not a patch. Omitting these fields
    // rewrites the rule — a silenced incident that is later re-enabled would
    // come back pointing nowhere, or on a different cadence.
    const s = scheduler((c) => (c instanceof GetScheduleCommand ? existing : {}));
    await s.make().pauseNudge("INC-1");

    expect(inputOf(s.send, 1)).toMatchObject({
      ScheduleExpression: existing.ScheduleExpression,
      FlexibleTimeWindow: existing.FlexibleTimeWindow,
      Target: existing.Target,
    });
  });

  it("does not throw when the rule cannot be read", async () => {
    const s = scheduler(() => {
      throw new ResourceNotFoundException({ message: "gone", Message: "gone", $metadata: {} });
    });
    await expect(s.make().pauseNudge("INC-1")).resolves.toBeUndefined();
  });
});
