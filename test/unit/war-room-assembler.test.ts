/**
 * Unit tests for WarRoomAssembler — the P1 alert → assembled war room path.
 *
 * There is an integration test alongside this one, but it runs against
 * dynamodb-local and is scoped to persistence semantics. This file covers the
 * orchestration decisions that have nothing to do with DynamoDB: what happens
 * when the directory lookup fails, when Grafana Cloud is down, when a Slack
 * post times out, and when one responder in a list of five cannot be invited.
 *
 * Every collaborator is a fake at the constructor seam, which is the point of
 * the port-based DI — the assembler never holds a WebClient or an SDK handle,
 * so none of this needs module mocking.
 */

import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { SlackAdapter } from "../../src/adapters/slack-adapter.js";
import type { GrafanaCloudClient } from "../../src/clients/grafana-cloud-client.js";
import type { GrafanaOnCallClient } from "../../src/clients/grafana-oncall-client.js";
import type { WorkOSClient } from "../../src/clients/workos-client.js";
import { WarRoomAssembler } from "../../src/services/war-room-assembler.js";
import type { NudgeScheduler } from "../../src/services/nudge-scheduler.js";
import type { GrafanaContextSnapshot, GrafanaOnCallAlertPayload } from "../../src/types/index.js";
import type { AuditWriter } from "../../src/utils/audit.js";
import type { MetricsEmitter } from "../../src/utils/metrics.js";

const alert: GrafanaOnCallAlertPayload = {
  alert_group_id: "ag-1",
  alert_group: { id: "ag-1", title: "API error rate breach", state: "firing" },
  integration_id: "int-1",
  route_id: "r-1",
  team_id: "t-1",
  team_name: "Payments",
  alerts: [],
};

// Fully populated on purpose, with no cast. A partial fixture forced through
// `as unknown as GrafanaContextSnapshot` typechecks and then throws inside
// buildContextSnapshotBlocks, which reads the nested rate fields — the cast
// silences the compiler exactly where it was telling the truth.
const snapshot: GrafanaContextSnapshot = {
  queried_at: "2026-08-18T00:00:00.000Z",
  error_rate_2h: { current: 0.12, baseline: 0.01, series_url: "https://grafana.example/d/abc" },
  p99_latency_ms: { current: 1800, baseline: 220 },
  error_budget_burn_rate: 14.2,
  log_excerpts: ["upstream connect error"],
  sample_trace_ids: ["trace-1"],
};

/**
 * Every SlackAdapter method as a mock.
 *
 * A `SlackAdapter & Record<string, Mock>` intersection does not work here:
 * TypeScript resolves the named keys to the interface's function signatures, so
 * `.mockResolvedValue` is invisible on exactly the methods a test needs to
 * drive. Mapping the keys instead keeps both the method names and the mock API.
 */
type SlackFake = { [K in keyof SlackAdapter]: Mock };

function makeSlack(overrides: Partial<SlackFake> = {}): SlackFake {
  return {
    createPrivateChannel: vi.fn().mockResolvedValue({ id: "C1", name: "war-room" }),
    postMessageCritical: vi.fn().mockResolvedValue({ ok: true, ts: "1.0" }),
    postMessageNonCritical: vi.fn().mockResolvedValue({ ok: true, ts: "1.0" }),
    pinMessage: vi.fn().mockResolvedValue(undefined),
    lookupUserByEmail: vi.fn().mockResolvedValue({ id: "U1" }),
    inviteToChannel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Audit events written, in order, as `EVENT` strings. */
function eventsOf(audit: { write: Mock }): string[] {
  return audit.write.mock.calls.map((c: unknown[]) => c[2] as string);
}

function payloadOf(audit: { write: Mock }, event: string) {
  const call = audit.write.mock.calls.find((c: unknown[]) => c[2] === event);
  return call?.[3] as Record<string, unknown> | undefined;
}

describe("WarRoomAssembler", () => {
  // `assemble` wraps every step in `withSpan`, which calls
  // `tracer.startActiveSpan`. Without a global context manager that reads
  // `context.active().current` on undefined and every assembly throws before
  // reaching the code under test — a failure that looks like a broken
  // assembler rather than a missing harness.
  let contextManager: AsyncHooksContextManager;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);
    provider = new BasicTracerProvider();
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    contextManager.disable();
    await provider.shutdown();
  });

  let slack: SlackFake;
  let docClient: { send: Mock };
  let directory: { getUsersInGroup: Mock };
  let onCall: {
    getEscalationChainForIntegration: Mock;
    extractEmailsFromChain: Mock;
  };
  let cloud: { getContextSnapshot: Mock };
  let audit: { write: Mock };
  let scheduler: { scheduleNudge: Mock };
  let metrics: { increment: Mock; duration: Mock };
  const ORIGINAL_MAP = process.env.WORKOS_TEAM_GROUP_MAP;

  function build(slackOverride?: SlackFake) {
    slack = slackOverride ?? makeSlack();
    return new WarRoomAssembler(
      slack as unknown as SlackAdapter,
      docClient as never,
      "incidents-table",
      directory as unknown as WorkOSClient,
      onCall as unknown as GrafanaOnCallClient,
      cloud as unknown as GrafanaCloudClient,
      audit as unknown as AuditWriter,
      scheduler as unknown as NudgeScheduler,
      "org-slug",
      metrics as unknown as MetricsEmitter,
    );
  }

  beforeEach(() => {
    docClient = { send: vi.fn().mockResolvedValue({}) };
    directory = { getUsersInGroup: vi.fn().mockResolvedValue([]) };
    onCall = {
      getEscalationChainForIntegration: vi.fn().mockResolvedValue({ id: "chain-1" }),
      extractEmailsFromChain: vi.fn().mockReturnValue([]),
    };
    cloud = { getContextSnapshot: vi.fn().mockResolvedValue(snapshot) };
    audit = { write: vi.fn().mockResolvedValue(undefined) };
    scheduler = { scheduleNudge: vi.fn().mockResolvedValue(undefined) };
    metrics = { increment: vi.fn(), duration: vi.fn() };
    delete process.env.WORKOS_TEAM_GROUP_MAP;
  });

  afterEach(() => {
    if (ORIGINAL_MAP === undefined) delete process.env.WORKOS_TEAM_GROUP_MAP;
    else process.env.WORKOS_TEAM_GROUP_MAP = ORIGINAL_MAP;
  });

  describe("happy path", () => {
    it("WRA-001: returns an assembled record carrying the channel and snapshot", async () => {
      onCall.extractEmailsFromChain.mockReturnValue(["ic@example.com"]);
      const record = await build().assemble(alert);

      expect(record.status).toBe("ROOM_ASSEMBLED");
      expect(record.slack_channel_id).toBe("C1");
      expect(record.responders).toEqual(["U1"]);
      expect(record.context_snapshot).toEqual(snapshot);
      expect(record.correlation_id).toBe("ag-1");
    });

    it("WRA-002: moves the incident to ROOM_ASSEMBLING before creating the channel", async () => {
      // Ordering matters: a crash between the two must leave a record that says
      // assembly was underway, not one that still reads as an untouched alert.
      const order: string[] = [];
      docClient.send.mockImplementation(() => {
        order.push("ddb");
        return Promise.resolve({});
      });
      const s = makeSlack();
      s.createPrivateChannel.mockImplementation(() => {
        order.push("channel");
        return Promise.resolve({ id: "C1", name: "war-room" });
      });

      await build(s).assemble(alert);

      expect(order[0]).toBe("ddb");
      expect(order[1]).toBe("channel");
    });

    it("WRA-003: pins the checklist and records it", async () => {
      await build().assemble(alert);

      expect(slack.pinMessage).toHaveBeenCalledWith("C1", "1.0", expect.anything());
      expect(eventsOf(audit)).toContain("CHECKLIST_PINNED");
    });

    it("WRA-004: schedules the 15-minute nudge against the created channel", async () => {
      await build().assemble(alert);
      expect(scheduler.scheduleNudge).toHaveBeenCalledWith("ag-1", "C1");
    });

    it("WRA-005: names each channel uniquely so adjacent incidents cannot collide", async () => {
      // Two drills on the same day share every stable component of the name.
      // Without the nonce the second conversations.create returns name_taken and
      // the second war room is never created.
      const a = build();
      await a.assemble(alert);
      const first = slack.createPrivateChannel.mock.calls[0][0] as string;
      const b = build();
      await b.assemble(alert);
      const second = slack.createPrivateChannel.mock.calls[0][0] as string;

      expect(first).not.toBe(second);
      expect(first).toMatch(/^incident-response-p1-\d{8}-ag-1-[0-9a-f]{6}$/);
    });
  });

  describe("directory lookup failure", () => {
    beforeEach(() => {
      onCall.getEscalationChainForIntegration.mockRejectedValue(new Error("WorkOS down"));
    });

    it("WRA-010: invites nobody rather than fabricating responders", async () => {
      const record = await build().assemble(alert);

      expect(slack.inviteToChannel).not.toHaveBeenCalled();
      expect(record.responders).toEqual([]);
    });

    it("WRA-011: writes both the failure and the fallback audit events", async () => {
      await build().assemble(alert);
      const events = eventsOf(audit);
      expect(events).toContain("DIRECTORY_LOOKUP_FAILED");
      expect(events).toContain("ASSEMBLY_FALLBACK_INITIATED");
    });

    it("WRA-012: tells the IC in-channel how to invite manually", async () => {
      await build().assemble(alert);
      const texts = slack.postMessageNonCritical.mock.calls.map(
        (c) => (c[0] as { text: string }).text,
      );
      expect(texts.some((t) => t.includes("/incident-response invite"))).toBe(true);
    });

    it("WRA-013: counts the failure and dimensions the duration by it", async () => {
      await build().assemble(alert);

      expect(metrics.increment).toHaveBeenCalledWith("directory_lookup_failure_count");
      const dims = metrics.duration.mock.calls[0][2] as Array<{ name: string; value: string }>;
      expect(dims).toContainEqual({ name: "directory_fallback", value: "true" });
    });

    it("WRA-014: still assembles the room", async () => {
      // A directory outage degrades responder invites. It must not cost the IC
      // the war room itself, which is the thing they are waiting on.
      const record = await build().assemble(alert);
      expect(record.status).toBe("ROOM_ASSEMBLED");
      expect(record.slack_channel_id).toBe("C1");
    });
  });

  describe("degraded collaborators", () => {
    it("WRA-020: proceeds without a snapshot when Grafana Cloud fails", async () => {
      cloud.getContextSnapshot.mockRejectedValue(new Error("Grafana down"));

      const record = await build().assemble(alert);

      expect(record.context_snapshot).toBeUndefined();
      expect(record.status).toBe("ROOM_ASSEMBLED");
      expect(payloadOf(audit, "CONTEXT_SNAPSHOT_ATTACHED")?.snapshot_present).toBe(false);
    });

    it("WRA-021: records why the context did not land when the Slack post fails", async () => {
      const s = makeSlack();
      // postMessageNonCritical returns undefined on timeout rather than throwing.
      s.postMessageNonCritical.mockResolvedValue(undefined);

      await build(s).assemble(alert);

      const p = payloadOf(audit, "CONTEXT_SNAPSHOT_ATTACHED");
      expect(p?.attached).toBe(false);
      expect(p?.failure_reason).toBe("slack_post_failed_or_timed_out");
    });

    it("WRA-022: does not pin or claim a checklist that was never posted", async () => {
      const s = makeSlack();
      s.postMessageNonCritical.mockResolvedValue(undefined);

      await build(s).assemble(alert);

      expect(s.pinMessage).not.toHaveBeenCalled();
      expect(eventsOf(audit)).not.toContain("CHECKLIST_PINNED");
    });

    it("WRA-023: aborts when the channel cannot be created", async () => {
      // The one genuinely critical Slack call — there is no war room to degrade
      // into, so this throws rather than returning a half-assembled record.
      const s = makeSlack();
      s.createPrivateChannel.mockRejectedValue(new Error("name_taken"));

      await expect(build(s).assemble(alert)).rejects.toThrow(/name_taken/);
      expect(scheduler.scheduleNudge).not.toHaveBeenCalled();
    });
  });

  describe("per-responder invite failures", () => {
    beforeEach(() => {
      onCall.extractEmailsFromChain.mockReturnValue([
        "first@example.com",
        "second@example.com",
        "third@example.com",
      ]);
    });

    it("WRA-030: one failed invite does not stop the rest", async () => {
      const s = makeSlack();
      s.lookupUserByEmail.mockImplementation((email: string) =>
        Promise.resolve({ id: `U-${email.split("@")[0]}` }),
      );
      s.inviteToChannel.mockImplementation((_c: string, userId: string) =>
        userId === "U-second" ? Promise.reject(new Error("already_in_channel")) : Promise.resolve(),
      );

      const record = await build(s).assemble(alert);

      expect(record.responders).toEqual(["U-first", "U-third"]);
      expect(eventsOf(audit)).toContain("RESPONDER_INVITE_FAILED");
      expect(payloadOf(audit, "RESPONDER_INVITE_FAILED")?.email).toBe("second@example.com");
    });

    it("WRA-031: skips an email Slack does not know without recording a failure", async () => {
      // A directory entry with no Slack account is an ordinary state, not an
      // error — recording it as a failure would train the IC to ignore the event.
      const s = makeSlack();
      s.lookupUserByEmail.mockResolvedValue(null);

      const record = await build(s).assemble(alert);

      expect(record.responders).toEqual([]);
      expect(s.inviteToChannel).not.toHaveBeenCalled();
      expect(eventsOf(audit)).not.toContain("RESPONDER_INVITE_FAILED");
    });

    it("WRA-032: records one RESPONDER_INVITED per successful invite", async () => {
      const s = makeSlack();
      s.lookupUserByEmail.mockImplementation((email: string) =>
        Promise.resolve({ id: `U-${email.split("@")[0]}` }),
      );

      await build(s).assemble(alert);

      expect(eventsOf(audit).filter((e) => e === "RESPONDER_INVITED")).toHaveLength(3);
    });
  });

  describe("responder resolution", () => {
    it("WRA-040: merges escalation-chain and directory emails without duplicates", async () => {
      onCall.extractEmailsFromChain.mockReturnValue(["shared@example.com", "chain@example.com"]);
      process.env.WORKOS_TEAM_GROUP_MAP = JSON.stringify({ "t-1": "grp-1" });
      directory.getUsersInGroup.mockResolvedValue([
        // Upper-case on purpose: Slack lookup is by exact address, so a directory
        // that returns mixed case would otherwise invite the same human twice.
        { email: "SHARED@example.com" },
        { email: "dir@example.com" },
      ]);
      const s = makeSlack();
      s.lookupUserByEmail.mockImplementation((email: string) =>
        Promise.resolve({ id: `U-${email}` }),
      );

      await build(s).assemble(alert);

      const looked = s.lookupUserByEmail.mock.calls.map((c) => c[0] as string);
      expect(looked).toEqual(["shared@example.com", "chain@example.com", "dir@example.com"]);
    });

    it("WRA-041: skips the directory entirely when no group is mapped for the team", async () => {
      process.env.WORKOS_TEAM_GROUP_MAP = JSON.stringify({ "other-team": "grp-9" });
      await build().assemble(alert);
      expect(directory.getUsersInGroup).not.toHaveBeenCalled();
    });

    it("WRA-042: tolerates an escalation chain that does not exist", async () => {
      onCall.getEscalationChainForIntegration.mockResolvedValue(null);
      const record = await build().assemble(alert);
      expect(record.responders).toEqual([]);
      expect(record.status).toBe("ROOM_ASSEMBLED");
    });
  });

  describe("metrics", () => {
    it("WRA-050: records assembly duration in seconds, not milliseconds", async () => {
      // The alert threshold is 300 and the instrument is named `_seconds`. A
      // millisecond value here reads 1000x high and the alert can never fire.
      await build().assemble(alert);

      const [name, value] = metrics.duration.mock.calls[0];
      expect(name).toBe("assembly_duration_seconds");
      expect(value).toBeLessThan(60);
    });

    it("WRA-051: assembles without a metrics emitter at all", async () => {
      // `metrics` is optional on the constructor; a missing emitter must not
      // take the war room down with it.
      const assembler = new WarRoomAssembler(
        makeSlack() as unknown as SlackAdapter,
        docClient as never,
        "incidents-table",
        directory as unknown as WorkOSClient,
        onCall as unknown as GrafanaOnCallClient,
        cloud as unknown as GrafanaCloudClient,
        audit as unknown as AuditWriter,
        scheduler as unknown as NudgeScheduler,
        "org-slug",
      );

      await expect(assembler.assemble(alert)).resolves.toMatchObject({
        status: "ROOM_ASSEMBLED",
      });
    });
  });
});
