/**
 * Unit tests for StatuspageApprovalGate — 100% branch coverage required.
 * THE MOST CRITICAL TESTS IN THE CODEBASE.
 */

import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { Mocked } from "vitest";
import "aws-sdk-client-mock-vitest/extend";

import type { StatuspageClient } from "../../src/clients/statuspage-client.js";
import { StatuspageApprovalGate } from "../../src/services/statuspage-approval-gate.js";
import { AutoPublishNotPermittedError } from "../../src/types/index.js";
import type { AuditWriter } from "../../src/utils/audit.js";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("StatuspageApprovalGate — SECURITY CRITICAL", () => {
  const TABLE_NAME = "incident-response-incidents-test";
  const INCIDENT_ID = "test-incident-001";
  const DRAFT_ID = "draft-001";
  const USER_ID = "U-ic-001";
  const DRAFT_BODY = "We are investigating an issue affecting some customers.";

  let gate: StatuspageApprovalGate;
  let mockAuditWriter: Mocked<AuditWriter>;
  let mockStatuspageClient: Mocked<StatuspageClient>;

  beforeEach(() => {
    ddbMock.reset();
    mockAuditWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      writeStatuspageApproval: vi.fn().mockResolvedValue({ body_sha256: "abc123" }),
      verifyApprovalBeforePublish: vi.fn().mockResolvedValue(undefined),
      auditApprovalGateViolations: vi.fn().mockResolvedValue([]),
    } as unknown as Mocked<AuditWriter>;

    mockStatuspageClient = {
      listComponents: vi.fn(),
      createIncident: vi.fn().mockResolvedValue({
        id: "sp-incident-001",
        shortlink: "https://status.example.com/incidents/sp-001",
        name: "Incident",
        status: "investigating",
        body: DRAFT_BODY,
        created_at: new Date().toISOString(),
        page_id: "page-001",
      }),
      updateIncident: vi.fn(),
    } as unknown as Mocked<StatuspageClient>;

    gate = new StatuspageApprovalGate(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-west-2" })),
      TABLE_NAME,
      mockAuditWriter,
      mockStatuspageClient,
    );
  });

  describe("createDraft()", () => {
    it("GATE-001: stores draft with PENDING_APPROVAL status and writes audit event", async () => {
      ddbMock.on(PutCommand).resolves({});
      const draft = await gate.createDraft(INCIDENT_ID, DRAFT_BODY, ["comp-001"], USER_ID);
      expect(draft.status).toBe("PENDING_APPROVAL");
      expect(draft.incident_id).toBe(INCIDENT_ID);
      expect(draft.body).toBe(DRAFT_BODY);
      expect(mockAuditWriter.write).toHaveBeenCalledWith(
        INCIDENT_ID,
        USER_ID,
        "STATUSPAGE_DRAFT_CREATED",
        expect.objectContaining({ body_sha256: draft.body_sha256 }),
      );
    });
  });

  describe("approveAndPublish()", () => {
    const mockDraftItem = {
      draft_id: DRAFT_ID,
      incident_id: INCIDENT_ID,
      body: DRAFT_BODY,
      body_sha256: "abc123",
      affected_component_ids: ["comp-001"],
      status: "PENDING_APPROVAL",
      created_at: new Date().toISOString(),
    };

    it("GATE-002: happy path — writes approval, verifies, calls Statuspage, writes published event", async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      ddbMock.on(UpdateCommand).resolves({});
      const result = await gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID);
      expect(mockAuditWriter.writeStatuspageApproval).toHaveBeenCalled();
      expect(mockAuditWriter.verifyApprovalBeforePublish).toHaveBeenCalled();
      expect(mockStatuspageClient.createIncident).toHaveBeenCalled();
      expect(mockAuditWriter.write).toHaveBeenCalledWith(
        INCIDENT_ID,
        USER_ID,
        "STATUSPAGE_PUBLISHED",
        expect.objectContaining({ statuspage_incident_id: "sp-incident-001" }),
      );
      expect(result.statuspage_incident_id).toBe("sp-incident-001");
    });

    it("GATE-003 [CRITICAL]: Statuspage API failure → PUBLISHED event NOT written", async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockStatuspageClient.createIncident.mockRejectedValue(new Error("Statuspage.io 503"));
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(
        /Statuspage\.io publish failed/,
      );
      expect(mockAuditWriter.write).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "STATUSPAGE_PUBLISHED",
        expect.anything(),
      );
    });

    it("GATE-003b: non-Error publish exception stringifies into error message", async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockStatuspageClient.createIncident.mockRejectedValue("not an Error instance");
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(
        /not an Error instance/,
      );
      expect(mockAuditWriter.write).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "STATUSPAGE_PUBLISHED",
        expect.anything(),
      );
    });

    it("GATE-004 [CRITICAL]: audit write failure → Statuspage NEVER called", async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockAuditWriter.writeStatuspageApproval.mockRejectedValue(new Error("DynamoDB down"));
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow();
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });

    it("GATE-004b [CRITICAL]: verifyApproval failure → Statuspage NEVER called", async () => {
      ddbMock.on(GetCommand).resolves({ Item: mockDraftItem });
      mockAuditWriter.verifyApprovalBeforePublish.mockRejectedValue(
        new AutoPublishNotPermittedError(INCIDENT_ID),
      );
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(
        AutoPublishNotPermittedError,
      );
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });

    it("GATE-005: throws if draft does not exist", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(
        `Draft ${DRAFT_ID} not found`,
      );
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });

    it("GATE-006: throws if draft is already PUBLISHED", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...mockDraftItem, status: "PUBLISHED" } });
      await expect(gate.approveAndPublish(INCIDENT_ID, DRAFT_ID, USER_ID)).rejects.toThrow(
        /not in PENDING_APPROVAL/,
      );
      expect(mockStatuspageClient.createIncident).not.toHaveBeenCalled();
    });
  });

  describe("rejectDraft()", () => {
    it("GATE-007: updates draft status to REJECTED and writes audit event", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      await gate.rejectDraft(INCIDENT_ID, DRAFT_ID, USER_ID);
      const updates = ddbMock.commandCalls(UpdateCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0]!.args[0]!.input.ExpressionAttributeValues).toMatchObject({
        ":status": "REJECTED",
      });
      expect(mockAuditWriter.write).toHaveBeenCalledWith(
        INCIDENT_ID,
        USER_ID,
        "STATUSPAGE_APPROVAL_REJECTED",
        expect.objectContaining({ draft_id: DRAFT_ID }),
      );
    });
  });
});

describe("reviseDraft — the IC's edit on the compliance-gated path", () => {
  const TABLE_NAME = "incident-response-incidents-test";
  const INCIDENT_ID = "test-incident-001";
  const DRAFT_ID = "draft-001";
  const USER_ID = "U-ic-001";
  const ORIGINAL_BODY = "We are investigating an issue affecting some customers.";
  const EDITED_BODY = "We have identified the cause and are deploying a fix.";
  // sha256 of ORIGINAL_BODY — the hash the stored draft carries before the edit.
  const ORIGINAL_SHA = createHash("sha256").update(ORIGINAL_BODY, "utf8").digest("hex");
  const EDITED_SHA = createHash("sha256").update(EDITED_BODY, "utf8").digest("hex");

  let gate: StatuspageApprovalGate;
  let mockAuditWriter: Mocked<AuditWriter>;

  const storedDraft = (status: string) => ({
    draft_id: DRAFT_ID,
    incident_id: INCIDENT_ID,
    body: ORIGINAL_BODY,
    body_sha256: ORIGINAL_SHA,
    affected_component_ids: ["comp-1"],
    status,
    created_at: "2026-07-25T00:00:00.000Z",
  });

  beforeEach(() => {
    ddbMock.reset();
    mockAuditWriter = {
      write: vi.fn().mockResolvedValue(undefined),
      writeStatuspageApproval: vi.fn().mockResolvedValue({ body_sha256: "abc123" }),
      verifyApprovalBeforePublish: vi.fn().mockResolvedValue(undefined),
      auditApprovalGateViolations: vi.fn().mockResolvedValue([]),
    } as unknown as Mocked<AuditWriter>;

    gate = new StatuspageApprovalGate(
      DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })),
      TABLE_NAME,
      mockAuditWriter,
      {} as unknown as StatuspageClient,
    );
  });

  // The hash is the whole reason an edit routes through the gate. approveAndPublish
  // hashes what it publishes and verifyApprovalBeforePublish matches it against the
  // approval record, so a body that changed without its hash following would either
  // publish unapproved text or fail the pre-publish check.
  it("rewrites the body and recomputes body_sha256", async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedDraft("PENDING_APPROVAL") });
    ddbMock.on(UpdateCommand).resolves({});

    const result = await gate.reviseDraft(INCIDENT_ID, DRAFT_ID, EDITED_BODY, USER_ID);

    expect(result.body_sha256).toBe(EDITED_SHA);
    expect(result.previous_body_sha256).toBe(ORIGINAL_SHA);

    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.ExpressionAttributeValues?.[":body"]).toBe(EDITED_BODY);
    expect(update?.ExpressionAttributeValues?.[":hash"]).toBe(EDITED_SHA);
  });

  // The edit must not become an implicit approval.
  it("leaves the draft PENDING_APPROVAL and re-asserts it at write time", async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedDraft("PENDING_APPROVAL") });
    ddbMock.on(UpdateCommand).resolves({});

    await gate.reviseDraft(INCIDENT_ID, DRAFT_ID, EDITED_BODY, USER_ID);

    const update = ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.UpdateExpression).not.toContain("#status =");
    expect(update?.ConditionExpression).toBe("#status = :pending");
    expect(update?.ExpressionAttributeValues?.[":pending"]).toBe("PENDING_APPROVAL");
  });

  it("writes an awaited audit event carrying both hashes", async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedDraft("PENDING_APPROVAL") });
    ddbMock.on(UpdateCommand).resolves({});

    await gate.reviseDraft(INCIDENT_ID, DRAFT_ID, EDITED_BODY, USER_ID);

    expect(mockAuditWriter.write).toHaveBeenCalledWith(
      INCIDENT_ID,
      USER_ID,
      "STATUSPAGE_DRAFT_REVISED",
      expect.objectContaining({
        draft_id: DRAFT_ID,
        body_sha256: EDITED_SHA,
        previous_body_sha256: ORIGINAL_SHA,
      }),
    );
  });

  it("refuses to edit an already-approved draft", async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedDraft("APPROVED") });

    await expect(gate.reviseDraft(INCIDENT_ID, DRAFT_ID, EDITED_BODY, USER_ID)).rejects.toThrow(
      /not in PENDING_APPROVAL/,
    );
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(mockAuditWriter.write).not.toHaveBeenCalled();
  });

  it("refuses to edit a draft that does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});

    await expect(gate.reviseDraft(INCIDENT_ID, DRAFT_ID, EDITED_BODY, USER_ID)).rejects.toThrow(
      /not found/,
    );
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("getDraft returns undefined rather than throwing when the draft is gone", async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(gate.getDraft(INCIDENT_ID, DRAFT_ID)).resolves.toBeUndefined();
  });

  it("getDraft returns the stored draft", async () => {
    ddbMock.on(GetCommand).resolves({ Item: storedDraft("PENDING_APPROVAL") });
    await expect(gate.getDraft(INCIDENT_ID, DRAFT_ID)).resolves.toMatchObject({
      draft_id: DRAFT_ID,
      body: ORIGINAL_BODY,
    });
  });
});
