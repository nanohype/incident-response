/**
 * Unit tests for the per-subcommand handlers.
 *
 * Each handler is a `make<Name>Handler(deps)` factory returning a
 * `CommandHandler`, so the whole surface is reachable by building a context and
 * calling it — no registry, no Slack transport, no module mocking.
 *
 * The recurring assertion is the repo's standing rule that a command never
 * claims work it did not do: `silence` records before it confirms, `status`
 * says there is no incident rather than rendering an empty one, and the draft
 * path tells the IC how to retry instead of failing quietly.
 *
 * `resolve` is covered in resolve-handler.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { makeChecklistHandler } from "../../src/commands/checklist.js";
import { makeHelpHandler } from "../../src/commands/help.js";
import { makeSilenceHandler } from "../../src/commands/silence.js";
import { makeStatusHandler, type StatusDeps } from "../../src/commands/status.js";
import type { CommandContext } from "../../src/services/command-registry.js";

type Ctx = CommandContext & { respond: ReturnType<typeof vi.fn> };

function makeCtx(overrides: Partial<CommandContext> = {}): Ctx {
  const slack = {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1.0" }) },
  } as unknown as WebClient;
  return {
    subCommand: "status",
    args: [],
    incidentId: "inc-1",
    userId: "U-ic",
    channelId: "C1",
    rawCommand: {} as CommandContext["rawCommand"],
    slack,
    respond: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as Ctx;
}

/** The text a handler replied with, via ctx.respond. */
function replyText(ctx: Ctx): string {
  return (ctx.respond.mock.calls[0]?.[0] as { text: string })?.text ?? "";
}

describe("help", () => {
  it("CMD-001: lists every subcommand the registry dispatches", async () => {
    // The registry is the source of truth for what exists; help drifting from
    // it is how a shipped command becomes undiscoverable.
    const ctx = makeCtx();
    await makeHelpHandler()(ctx);

    const text = replyText(ctx);
    for (const cmd of ["status", "resolve", "checklist", "silence", "help"]) {
      expect(text).toContain(`/incident-response ${cmd}`);
    }
  });
});

describe("checklist", () => {
  it("CMD-010: says what it does and does not do, rather than claiming a re-pin", async () => {
    // A silent stub is a bug here: replying "refreshed" for work that did not
    // happen would leave the IC trusting a checklist nobody touched.
    const ctx = makeCtx();
    await makeChecklistHandler()(ctx);

    const text = replyText(ctx);
    expect(text).toMatch(/source of truth/i);
    expect(text).not.toMatch(/refreshed|re-pinned|done/i);
  });
});

describe("silence", () => {
  function deps() {
    return {
      nudgeScheduler: { pauseNudge: vi.fn().mockResolvedValue(undefined) },
      auditWriter: { write: vi.fn().mockResolvedValue(undefined) },
    };
  }

  it("CMD-020: pauses the schedule and records who silenced it", async () => {
    const d = deps();
    const ctx = makeCtx();
    await makeSilenceHandler(d as never)(ctx);

    expect(d.nudgeScheduler.pauseNudge).toHaveBeenCalledWith("inc-1");
    expect(d.auditWriter.write).toHaveBeenCalledWith(
      "inc-1",
      "U-ic",
      "STATUS_REMINDER_SILENCED",
      expect.objectContaining({ channel_id: "C1" }),
    );
    expect(replyText(ctx)).toMatch(/silenced/i);
  });

  it("CMD-021: does not confirm silencing when the schedule could not be paused", async () => {
    // The IC would otherwise stop expecting nudges that keep firing.
    const d = deps();
    d.nudgeScheduler.pauseNudge.mockRejectedValue(new Error("ResourceNotFoundException"));
    const ctx = makeCtx();

    await expect(makeSilenceHandler(d as never)(ctx)).rejects.toThrow();
    expect(ctx.respond).not.toHaveBeenCalled();
  });

  it("CMD-022: records the silence before confirming it", async () => {
    // Ordering matters for the audit trail: a confirmation the IC saw must not
    // be able to exist without the record that explains why nudges stopped.
    const order: string[] = [];
    const d = deps();
    d.auditWriter.write.mockImplementation(() => {
      order.push("audit");
      return Promise.resolve();
    });
    const ctx = makeCtx({
      respond: vi.fn().mockImplementation(() => {
        order.push("respond");
        return Promise.resolve();
      }),
    });

    await makeSilenceHandler(d as never)(ctx);

    expect(order).toEqual(["audit", "respond"]);
  });
});

describe("status", () => {
  function deps(item: unknown, overrides: Partial<StatusDeps> = {}): StatusDeps {
    return {
      docClient: { send: vi.fn().mockResolvedValue({ Item: item }) },
      incidentsTableName: "incidents",
      incidentResponseAI: { generateStatusDraft: vi.fn().mockResolvedValue("a draft") },
      approvalGate: { createDraft: vi.fn().mockResolvedValue({ draft_id: "d-1" }) },
      ...overrides,
    } as unknown as StatusDeps;
  }

  const incident = {
    incident_id: "inc-1",
    status: "ROOM_ASSEMBLED",
    severity: "P1",
    responders: ["U1", "U2"],
  };

  it("CMD-030: reports the stored status, severity and responder count", async () => {
    const ctx = makeCtx();
    await makeStatusHandler(deps(incident))(ctx);

    const text = replyText(ctx);
    expect(text).toContain("ROOM_ASSEMBLED");
    expect(text).toContain("P1");
    expect(text).toContain("2");
  });

  it("CMD-031: says there is no incident rather than rendering an empty one", async () => {
    const ctx = makeCtx();
    await makeStatusHandler(deps(undefined))(ctx);

    expect(replyText(ctx)).toMatch(/no active incident/i);
  });

  describe("status draft", () => {
    it("CMD-040: drafts from the stored alert and posts it for approval", async () => {
      const d = deps({ ...incident, alert_payload: { alert_group_id: "ag-1" } });
      const ctx = makeCtx({ args: ["draft"] });

      await makeStatusHandler(d)(ctx);

      const ai = d.incidentResponseAI.generateStatusDraft as unknown as ReturnType<typeof vi.fn>;
      expect(ai.mock.calls[0][0]).toMatchObject({ alert_group_id: "ag-1" });
      // Through the gate, which is what makes the draft PENDING_APPROVAL rather
      // than something publishable.
      expect(d.approvalGate.createDraft).toHaveBeenCalledWith("inc-1", "a draft", [], "U-ic");
      expect(ctx.slack.chat.postMessage).toHaveBeenCalled();
    });

    it("CMD-041: synthesises a placeholder alert when none is stored", async () => {
      // A draft requested before the alert payload landed still has to produce
      // something the IC can edit, rather than throwing on a missing field.
      const d = deps(undefined);
      const ctx = makeCtx({ args: ["draft"] });

      await makeStatusHandler(d)(ctx);

      const ai = d.incidentResponseAI.generateStatusDraft as unknown as ReturnType<typeof vi.fn>;
      expect(ai.mock.calls[0][0]).toMatchObject({ alert_group_id: "inc-1" });
      expect(d.approvalGate.createDraft).toHaveBeenCalled();
    });

    it("CMD-042: tells the IC how to retry when drafting fails", async () => {
      const d = deps(incident, {
        incidentResponseAI: {
          generateStatusDraft: vi.fn().mockRejectedValue(new Error("gateway down")),
        } as unknown as StatusDeps["incidentResponseAI"],
      });
      const ctx = makeCtx({ args: ["draft"] });

      await makeStatusHandler(d)(ctx);

      expect(replyText(ctx)).toMatch(/status draft/i);
      expect(replyText(ctx)).toMatch(/retry/i);
    });

    it("CMD-043: publishes nothing when the approval gate refuses the draft", async () => {
      // The gate is the only path to a customer-visible message. If it refuses,
      // the IC gets an error — never a Block Kit approval card for a draft that
      // was never stored.
      const d = deps(incident, {
        approvalGate: {
          createDraft: vi.fn().mockRejectedValue(new Error("draft rejected")),
        } as unknown as StatusDeps["approvalGate"],
      });
      const ctx = makeCtx({ args: ["draft"] });

      await makeStatusHandler(d)(ctx);

      expect(ctx.slack.chat.postMessage).not.toHaveBeenCalled();
      expect(replyText(ctx)).toMatch(/failed/i);
    });
  });
});
