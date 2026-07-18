/**
 * Unit tests for the signed-HTTP Slack interactions surface.
 *
 * The load-bearing case: `statuspage_approve` MUST call the approval gate with
 * the CLICKING HUMAN's id as the approver (SLK-INT-010). That is the whole
 * reason the publish stays a human Slack gesture and is not an MCP tool.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { Mock } from "vitest";
import "aws-sdk-client-mock-vitest/extend";

import {
  handleInteraction,
  handleSlashCommand,
  type InteractionPayload,
  parseInteraction,
  parseSlashCommand,
  type SlackInteractionDeps,
} from "../../src/handlers/slack-interactions.js";
import { CommandRegistry } from "../../src/services/command-registry.js";
import type { SlashCommand } from "../../src/types/slack.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

interface Fakes extends SlackInteractionDeps {
  approvalGate: { approveAndPublish: Mock };
  auditWriter: { write: Mock };
  slack: { views: { open: Mock } } & SlackInteractionDeps["slack"];
  respondTo: Mock;
  commandRegistry: CommandRegistry;
}

function mkDeps(): Fakes {
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-west-2" }));
  const approvalGate = {
    approveAndPublish: vi
      .fn()
      .mockResolvedValue({ statuspage_incident_id: "sp-1", shortlink: "https://status/1" }),
  };
  const auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
  const slack = { views: { open: vi.fn().mockResolvedValue({}) } };
  return {
    commandRegistry: new CommandRegistry(),
    approvalGate,
    auditWriter,
    dynamoDb: docClient,
    incidentsTableName: "tbl",
    slack: slack as unknown as SlackInteractionDeps["slack"],
    respondTo: vi.fn().mockResolvedValue(undefined),
  } as Fakes;
}

function mkCommand(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    command: "/incident-response",
    text: "status",
    user_id: "U-ic",
    channel_id: "C-war",
    team_id: "T1",
    response_url: "https://hooks.slack.com/actions/T1/abc/def",
    trigger_id: "tg-1",
    ...overrides,
  };
}

beforeEach(() => ddbMock.reset());

describe("handleSlashCommand", () => {
  it("SLK-INT-001: channel-scoped command resolves incident and dispatches with attribution", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ incident_id: "inc-9" }] });
    const deps = mkDeps();
    const handler = vi.fn().mockResolvedValue(undefined);
    deps.commandRegistry.register("status", handler);

    await handleSlashCommand(deps, mkCommand({ text: "status" }));

    expect(deps.auditWriter.write).toHaveBeenCalledWith(
      "C-war",
      "U-ic",
      "SLASH_COMMAND_RECEIVED",
      expect.objectContaining({ command: "status" }),
    );
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ incidentId: "inc-9", userId: "U-ic", channelId: "C-war" }),
    );
  });

  it("SLK-INT-002: no incident for channel → replies, does not dispatch", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const deps = mkDeps();
    const handler = vi.fn();
    deps.commandRegistry.register("status", handler);

    await handleSlashCommand(deps, mkCommand({ text: "status" }));

    expect(handler).not.toHaveBeenCalled();
    expect(deps.respondTo).toHaveBeenCalledWith(
      "https://hooks.slack.com/actions/T1/abc/def",
      expect.objectContaining({ text: expect.stringContaining("No active incident") }),
    );
  });

  it("SLK-INT-003: over-long command text → error reply, no dispatch or audit", async () => {
    const deps = mkDeps();
    const handler = vi.fn();
    deps.commandRegistry.register("status", handler);

    await handleSlashCommand(deps, mkCommand({ text: "a".repeat(501) }));

    expect(handler).not.toHaveBeenCalled();
    expect(deps.auditWriter.write).not.toHaveBeenCalled();
    expect(deps.respondTo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: expect.stringContaining("under 500 characters") }),
    );
  });

  it("SLK-INT-004: non-scoped help dispatches with channel_id fallback (no GSI lookup)", async () => {
    const deps = mkDeps();
    const handler = vi.fn().mockResolvedValue(undefined);
    deps.commandRegistry.register("help", handler);

    await handleSlashCommand(deps, mkCommand({ text: "help" }));

    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ incidentId: "C-war" }));
  });

  it("SLK-INT-005: channel resolution failure → internal-error reply", async () => {
    ddbMock.on(QueryCommand).rejects(new Error("ddb down"));
    const deps = mkDeps();
    deps.commandRegistry.register("resolve", vi.fn());

    await handleSlashCommand(deps, mkCommand({ text: "resolve" }));

    expect(deps.respondTo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: expect.stringContaining("Internal error") }),
    );
  });

  it("SLK-INT-006: too many args → error reply", async () => {
    const deps = mkDeps();
    deps.commandRegistry.register("help", vi.fn());
    await handleSlashCommand(deps, mkCommand({ text: `help ${"x ".repeat(11)}` }));
    expect(deps.respondTo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: expect.stringContaining("Too many") }),
    );
  });
});

describe("handleInteraction", () => {
  function approvePayload(): InteractionPayload {
    return {
      type: "block_actions",
      user: { id: "U-approver" },
      response_url: "https://hooks.slack.com/actions/approve",
      actions: [
        {
          action_id: "statuspage_approve",
          value: JSON.stringify({ incident_id: "inc-1", draft_id: "d-1" }),
        },
      ],
    };
  }

  it("SLK-INT-010 [CRITICAL]: approve publishes with the clicking human as approver", async () => {
    const deps = mkDeps();
    await handleInteraction(deps, approvePayload());
    expect(deps.approvalGate.approveAndPublish).toHaveBeenCalledWith("inc-1", "d-1", "U-approver");
    expect(deps.respondTo).toHaveBeenCalledWith(
      "https://hooks.slack.com/actions/approve",
      expect.objectContaining({
        text: expect.stringContaining("published by <@U-approver>"),
        replace_original: true,
      }),
    );
  });

  it("SLK-INT-011: approve failure surfaces an error reply, still attributed to the human", async () => {
    const deps = mkDeps();
    deps.approvalGate.approveAndPublish.mockRejectedValue(new Error("gate rejected"));
    await handleInteraction(deps, approvePayload());
    expect(deps.approvalGate.approveAndPublish).toHaveBeenCalledWith("inc-1", "d-1", "U-approver");
    expect(deps.respondTo).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ text: expect.stringContaining("gate rejected") }),
    );
  });

  it("SLK-INT-012: pulse rating writes IC_RATED with the rater id", async () => {
    const deps = mkDeps();
    await handleInteraction(deps, {
      type: "block_actions",
      user: { id: "U-rater" },
      response_url: "https://hooks/x",
      actions: [{ action_id: "pulse_rate_4", value: JSON.stringify({ incident_id: "inc-2" }) }],
    });
    expect(deps.auditWriter.write).toHaveBeenCalledWith(
      "inc-2",
      "U-rater",
      "IC_RATED",
      expect.objectContaining({ rating: 4 }),
    );
  });

  it("SLK-INT-013: silence_reminders is a no-op ack (no publish, no dispatch)", async () => {
    const deps = mkDeps();
    await handleInteraction(deps, {
      type: "block_actions",
      user: { id: "U1" },
      channel: { id: "C1" },
      actions: [{ action_id: "silence_reminders" }],
    });
    expect(deps.approvalGate.approveAndPublish).not.toHaveBeenCalled();
    expect(deps.auditWriter.write).not.toHaveBeenCalled();
  });

  it("SLK-INT-014: edit opens the draft modal", async () => {
    const deps = mkDeps();
    await handleInteraction(deps, {
      type: "block_actions",
      user: { id: "U1" },
      trigger_id: "tg-9",
      actions: [
        {
          action_id: "statuspage_edit",
          value: JSON.stringify({ incident_id: "inc-1", draft_id: "d-1" }),
        },
      ],
    });
    expect(deps.slack.views.open).toHaveBeenCalledWith(
      expect.objectContaining({ trigger_id: "tg-9" }),
    );
  });

  it("SLK-INT-015: empty actions array is ignored", async () => {
    const deps = mkDeps();
    await handleInteraction(deps, { type: "block_actions", user: { id: "U1" }, actions: [] });
    expect(deps.approvalGate.approveAndPublish).not.toHaveBeenCalled();
  });

  it("SLK-INT-016: unknown action_id is logged and ignored", async () => {
    const deps = mkDeps();
    await handleInteraction(deps, {
      type: "block_actions",
      user: { id: "U1" },
      actions: [{ action_id: "mystery_button" }],
    });
    expect(deps.approvalGate.approveAndPublish).not.toHaveBeenCalled();
    expect(deps.auditWriter.write).not.toHaveBeenCalled();
  });
});

describe("parsing", () => {
  it("SLK-INT-020: parseSlashCommand reads the urlencoded fields", () => {
    const body =
      "command=%2Fincident-response&text=status+draft&user_id=U9&channel_id=C9&response_url=https%3A%2F%2Fhooks%2Fx&trigger_id=tg&team_id=T9";
    const cmd = parseSlashCommand(body);
    expect(cmd).toMatchObject({
      command: "/incident-response",
      text: "status draft",
      user_id: "U9",
      channel_id: "C9",
      response_url: "https://hooks/x",
      trigger_id: "tg",
      team_id: "T9",
    });
  });

  it("SLK-INT-021: parseInteraction decodes the payload JSON", () => {
    const payload = { type: "block_actions", user: { id: "U1" }, actions: [] };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    expect(parseInteraction(body)).toMatchObject({ type: "block_actions", user: { id: "U1" } });
  });
});
