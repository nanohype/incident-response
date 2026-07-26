/**
 * Unit tests for the webhook ingress handler's atomic-create behavior.
 *
 * P1 race fix: two concurrent firing webhooks for the same alert_group_id must collapse.
 * The loser sees ConditionalCheckFailedException on the conditional Put and returns 200
 * WITHOUT re-enqueuing ALERT_RECEIVED (which would otherwise create a second Slack channel).
 */

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import "aws-sdk-client-mock-vitest/extend";
import * as crypto from "node:crypto";

import {
  __resetHmacCacheForTests,
  handler,
  type WebhookRequest,
} from "../../src/handlers/webhook-ingress.js";

const smMock = mockClient(SecretsManagerClient);
const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);

const HMAC_SECRET = "test-secret";

function signedEvent(body: string): WebhookRequest {
  const signature = crypto.createHmac("sha256", HMAC_SECRET).update(body, "utf8").digest("hex");
  return {
    headers: { "x-grafana-oncall-signature": signature },
    body,
  };
}

function firingPayload(alertGroupId = "alert-group-001") {
  return {
    alert_group_id: alertGroupId,
    alert_group: { id: alertGroupId, title: "P1 DB outage", state: "firing" as const },
    integration_id: "integration-123",
    route_id: "route-1",
    team_id: "team-platform",
    team_name: "Platform",
    alerts: [
      {
        id: "alert-1",
        title: "P1 DB outage",
        message: "connection refused on db-prod",
        received_at: "2026-04-16T00:00:00Z",
      },
    ],
  };
}

function invokeHandler(event: WebhookRequest) {
  return handler(event);
}

describe("webhook-ingress atomic-create", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    smMock.reset();
    ddbMock.reset();
    sqsMock.reset();
    __resetHmacCacheForTests();
    process.env.GRAFANA_ONCALL_HMAC_SECRET_ID =
      "arn:aws:secretsmanager:us-west-2:000000000000:secret:test";
    process.env.INCIDENTS_TABLE_NAME = "incident-response-incidents-test";
    process.env.INCIDENT_EVENTS_QUEUE_URL =
      "https://sqs.us-west-2.amazonaws.com/000000000000/incident-response-events.fifo";
    smMock.on(GetSecretValueCommand).resolves({ SecretString: HMAC_SECRET, VersionId: "v1" });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("WEBHOOK-001: fresh firing alert → conditional Put succeeds → enqueue ALERT_RECEIVED → 200", async () => {
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });

    const body = JSON.stringify(firingPayload());
    const result = await invokeHandler(signedEvent(body));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: "Alert accepted",
      incident_id: "alert-group-001",
    });
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: "incident-response-incidents-test",
      ConditionExpression: "attribute_not_exists(PK)",
    });
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 1);
    expect(sqsMock).toHaveReceivedCommandWith(SendMessageCommand, {
      MessageDeduplicationId: "received-alert-group-001",
    });
  });

  it("WEBHOOK-002: concurrent firing webhook → ConditionalCheckFailedException → 200 duplicate, no SQS enqueue", async () => {
    ddbMock.on(PutCommand).rejects(
      new ConditionalCheckFailedException({
        message: "already exists",
        $metadata: {},
      }),
    );

    const body = JSON.stringify(firingPayload());
    const result = await invokeHandler(signedEvent(body));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      message: "Duplicate event ignored",
      incident_id: "alert-group-001",
    });
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });

  it("WEBHOOK-003: silenced alert → 200 no-op, no DDB / SQS", async () => {
    const payload = {
      ...firingPayload(),
      alert_group: { ...firingPayload().alert_group, state: "silenced" as const },
    };
    const result = await invokeHandler(signedEvent(JSON.stringify(payload)));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ message: "Silenced alert ignored" });
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });

  it("WEBHOOK-004: resolved alert → enqueue ALERT_RESOLVED → 200, no DDB", async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m2" });
    const payload = {
      ...firingPayload(),
      alert_group: { ...firingPayload().alert_group, state: "resolved" as const },
    };
    const result = await invokeHandler(signedEvent(JSON.stringify(payload)));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ message: "Resolution event queued" });
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 1);
    expect(sqsMock).toHaveReceivedCommandWith(SendMessageCommand, {
      MessageBody: expect.stringContaining('"ALERT_RESOLVED"') as unknown as string,
    });
  });

  it("WEBHOOK-005: invalid HMAC → 401, no DDB / SQS", async () => {
    const body = JSON.stringify(firingPayload());
    const evt = { ...signedEvent(body), headers: { "x-grafana-oncall-signature": "deadbeef" } };
    const result = await invokeHandler(evt);

    expect(result.statusCode).toBe(401);
    expect(ddbMock).toHaveReceivedCommandTimes(PutCommand, 0);
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });

  it("WEBHOOK-006: malformed JSON body → 400", async () => {
    const body = "{not valid json";
    const result = await invokeHandler(signedEvent(body));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ error: "Invalid JSON" });
  });

  it("WEBHOOK-007: non-ConditionalCheckFailed DynamoDB error → propagates (the server answers 500 so Grafana OnCall retries)", async () => {
    ddbMock.on(PutCommand).rejects(new Error("ProvisionedThroughputExceededException"));

    const body = JSON.stringify(firingPayload());
    await expect(invokeHandler(signedEvent(body))).rejects.toThrow(
      "ProvisionedThroughputExceededException",
    );
    expect(sqsMock).toHaveReceivedCommandTimes(SendMessageCommand, 0);
  });
});

/**
 * Fail-closed when the signing secret cannot be fetched.
 *
 * The ingress authenticates every inbound webhook against an HMAC secret held in
 * Secrets Manager. If that fetch fails there is no way to tell a genuine Grafana
 * call from a forged one, so the only safe answer is to reject — a 500 the
 * caller retries, never a 200 for a request whose signature was never checked.
 * Secrets Manager being briefly unavailable must not become an open door.
 */
describe("webhook ingress — HMAC secret unavailable", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    smMock.reset();
    ddbMock.reset();
    sqsMock.reset();
    __resetHmacCacheForTests();
    process.env.GRAFANA_ONCALL_HMAC_SECRET_ID =
      "arn:aws:secretsmanager:us-west-2:000000000000:secret:test";
    process.env.INCIDENTS_TABLE_NAME = "incident-response-incidents-test";
    process.env.INCIDENT_EVENTS_QUEUE_URL =
      "https://sqs.us-west-2.amazonaws.com/000000000000/incident-response-events.fifo";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("rejects with 500 and writes nothing when the secret fetch throws", async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error("AccessDeniedException"));

    const body = JSON.stringify(firingPayload());
    const response = await handler(signedEvent(body));

    expect(response.statusCode).toBe(500);
    // Nothing may be persisted or enqueued off an unverified request.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

/**
 * Malformed requests reach the signature check as empty strings rather than as
 * undefined, and must be rejected there. A request with no body or no signature
 * header is the cheapest possible forgery attempt; it has to fail the HMAC
 * comparison like any other, not throw on a property access before it gets there.
 */
describe("webhook ingress — malformed requests", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    smMock.reset();
    ddbMock.reset();
    sqsMock.reset();
    __resetHmacCacheForTests();
    process.env.GRAFANA_ONCALL_HMAC_SECRET_ID =
      "arn:aws:secretsmanager:us-west-2:000000000000:secret:test";
    process.env.INCIDENTS_TABLE_NAME = "incident-response-incidents-test";
    process.env.INCIDENT_EVENTS_QUEUE_URL =
      "https://sqs.us-west-2.amazonaws.com/000000000000/incident-response-events.fifo";
    smMock.on(GetSecretValueCommand).resolves({ SecretString: HMAC_SECRET, VersionId: "v1" });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("rejects a request with no signature header", async () => {
    const response = await handler({ headers: {}, body: JSON.stringify(firingPayload()) });
    expect(response.statusCode).toBe(401);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("rejects a request with no headers at all", async () => {
    const response = await handler({ body: JSON.stringify(firingPayload()) } as WebhookRequest);
    expect(response.statusCode).toBe(401);
  });

  // A correctly signed request whose payload does not match the schema. The
  // signature proves the sender, not the shape — a Grafana version change or a
  // misconfigured route sends authentic garbage, and it must be a 400 that names
  // the problem rather than a crash deeper in the handler.
  it("rejects a correctly signed request whose payload fails the schema", async () => {
    const body = JSON.stringify({ not: "a grafana payload" });
    const response = await handler(signedEvent(body));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("Invalid payload");
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("rejects a correctly signed request whose body is not JSON", async () => {
    const response = await handler(signedEvent("not json at all"));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe("Invalid JSON");
  });

  it("rejects a request with no body", async () => {
    const response = await handler({
      headers: { "x-grafana-oncall-signature": "deadbeef" },
    } as WebhookRequest);
    expect(response.statusCode).toBe(401);
  });

  it("falls back to the default table name when the env var is unset", async () => {
    const previous = process.env.INCIDENTS_TABLE_NAME;
    process.env.INCIDENTS_TABLE_NAME = undefined;
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });

    try {
      const body = JSON.stringify(firingPayload("alert-group-default-table"));
      const response = await handler(signedEvent(body));

      expect(response.statusCode).toBe(200);
      expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.TableName).toBe(
        "incident-response-incidents",
      );
    } finally {
      if (previous !== undefined) process.env.INCIDENTS_TABLE_NAME = previous;
    }
  });
});

/**
 * Rotation-race recovery through the handler.
 *
 * hmac-cache.test.ts proves the cache refetches on force; this proves the
 * ingress uses that to *accept* a request rather than only to reject one. Grafana
 * signs with the new secret the moment rotation lands, so a cached previous
 * value would 401 every genuine webhook until the TTL expired — an outage that
 * looks exactly like an attack.
 */
describe("webhook ingress — secret rotated mid-flight", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    smMock.reset();
    ddbMock.reset();
    sqsMock.reset();
    __resetHmacCacheForTests();
    process.env.GRAFANA_ONCALL_HMAC_SECRET_ID =
      "arn:aws:secretsmanager:us-west-2:000000000000:secret:test";
    process.env.INCIDENTS_TABLE_NAME = "incident-response-incidents-test";
    process.env.INCIDENT_EVENTS_QUEUE_URL =
      "https://sqs.us-west-2.amazonaws.com/000000000000/incident-response-events.fifo";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("accepts a request signed with the new secret after a forced refetch", async () => {
    const NEW_SECRET = "rotated-secret";
    smMock
      .on(GetSecretValueCommand)
      .resolvesOnce({ SecretString: "stale-secret", VersionId: "v1" })
      .resolves({ SecretString: NEW_SECRET, VersionId: "v2" });
    ddbMock.on(PutCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m-1" });

    const body = JSON.stringify(firingPayload("alert-group-rotation"));
    const signature = crypto.createHmac("sha256", NEW_SECRET).update(body, "utf8").digest("hex");

    const response = await handler({
      headers: { "x-grafana-oncall-signature": signature },
      body,
    });

    expect(response.statusCode).toBe(200);
    // Two fetches: the cached miss, then the forced refresh that recovered it.
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });
});
