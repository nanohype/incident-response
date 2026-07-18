/**
 * Unit tests for Slack request signature verification.
 *
 * This is the trust boundary for every human safety gesture — including the
 * compliance-gated `statuspage_approve` publish — so valid / invalid / expired
 * are all covered.
 */

import * as crypto from "node:crypto";
import {
  SLACK_MAX_SKEW_SECONDS,
  verifySlackSignature,
} from "../../src/handlers/slack-signature.js";

const SECRET = "top-secret-signing-key";
const BODY = "command=%2Fincident-response&text=status&user_id=U123&channel_id=C1";

function sign(ts: number, body: string, secret = SECRET): string {
  return `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`, "utf8").digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const now = 1_700_000_000; // fixed unix seconds
  const nowMs = now * 1000;

  it("SIG-001: accepts a valid, fresh signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(now, BODY),
        timestamp: String(now),
        rawBody: BODY,
        nowMs,
      }),
    ).toBe(true);
  });

  it("SIG-002: rejects a tampered body", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(now, BODY),
        timestamp: String(now),
        rawBody: `${BODY}&injected=1`,
        nowMs,
      }),
    ).toBe(false);
  });

  it("SIG-003: rejects a signature computed with the wrong secret", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(now, BODY, "wrong-secret"),
        timestamp: String(now),
        rawBody: BODY,
        nowMs,
      }),
    ).toBe(false);
  });

  it("SIG-004: rejects a stale timestamp (> 5 min old)", () => {
    const staleTs = now - (SLACK_MAX_SKEW_SECONDS + 1);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(staleTs, BODY),
        timestamp: String(staleTs),
        rawBody: BODY,
        nowMs,
      }),
    ).toBe(false);
  });

  it("SIG-005: rejects a future timestamp beyond skew", () => {
    const futureTs = now + (SLACK_MAX_SKEW_SECONDS + 1);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(futureTs, BODY),
        timestamp: String(futureTs),
        rawBody: BODY,
        nowMs,
      }),
    ).toBe(false);
  });

  it("SIG-006: rejects missing signature / timestamp / secret", () => {
    const base = { signingSecret: SECRET, rawBody: BODY, nowMs };
    expect(verifySlackSignature({ ...base, signature: undefined, timestamp: String(now) })).toBe(
      false,
    );
    expect(
      verifySlackSignature({ ...base, signature: sign(now, BODY), timestamp: undefined }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        signingSecret: "",
        rawBody: BODY,
        nowMs,
        signature: sign(now, BODY),
        timestamp: String(now),
      }),
    ).toBe(false);
  });

  it("SIG-007: rejects a non-numeric timestamp", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(now, BODY),
        timestamp: "not-a-number",
        rawBody: BODY,
        nowMs,
      }),
    ).toBe(false);
  });

  it("SIG-008: rejects a malformed (wrong-length) signature without throwing", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: "v0=short",
        timestamp: String(now),
        rawBody: BODY,
        nowMs,
      }),
    ).toBe(false);
  });

  it("SIG-009: defaults to the real clock when nowMs is omitted", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: sign(ts, BODY),
        timestamp: String(ts),
        rawBody: BODY,
      }),
    ).toBe(true);
  });
});
