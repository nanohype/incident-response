/**
 * Slack request signature verification (v0 scheme).
 *
 * Slack signs every slash-command and interactivity POST it sends to a
 * Request URL. The webhook Deployment receives those over signed HTTP, so this
 * is the trust boundary for the human safety gestures — including the
 * compliance-gated `statuspage_approve` publish.
 *
 * Scheme (https://api.slack.com/authentication/verifying-requests-from-slack):
 *   basestring = `v0:{X-Slack-Request-Timestamp}:{rawBody}`
 *   expected   = `v0=` + HMAC-SHA256(signingSecret, basestring) as hex
 * Compared to `X-Slack-Signature` with `crypto.timingSafeEqual`. Requests
 * older than 5 minutes are rejected to blunt replay.
 */

import * as crypto from "node:crypto";

/** Reject timestamps more than this far from now (replay protection). */
export const SLACK_MAX_SKEW_SECONDS = 5 * 60;

export interface SlackSignatureInput {
  signingSecret: string;
  /** `X-Slack-Signature` header value (e.g. `v0=abc123…`). */
  signature: string | undefined;
  /** `X-Slack-Request-Timestamp` header value (unix seconds, as a string). */
  timestamp: string | undefined;
  /** The exact raw request body the signature was computed over. */
  rawBody: string;
  /** Injectable clock (unix ms) for deterministic tests. Defaults to now. */
  nowMs?: number;
}

/**
 * Constant-time verification of a Slack request signature. Returns `false`
 * (never throws) for any failure: missing headers, stale timestamp, malformed
 * signature, or mismatch. A `false` here MUST map to an HTTP 401 — the caller
 * never trusts an unverified Slack body.
 */
export function verifySlackSignature(input: SlackSignatureInput): boolean {
  const { signingSecret, signature, timestamp, rawBody } = input;
  if (!signingSecret || !signature || !timestamp) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - ts) > SLACK_MAX_SKEW_SECONDS) return false;

  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(basestring, "utf8").digest("hex")}`;

  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
