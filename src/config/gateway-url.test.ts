import { describe, expect, it } from "vitest";
import { anthropicBaseUrl } from "./gateway-url.js";

const GATEWAY = "http://incident-response-gateway.tenants-incident-response.svc.cluster.local:8080";

describe("anthropicBaseUrl", () => {
  it("puts the SDK's /v1/messages under the gateway's anthropic prefix", () => {
    // The assertion is on the full path the SDK ultimately requests, not on
    // the base URL alone: the full path is what has to match an endpoint the
    // gateway has registered a processor for.
    expect(`${anthropicBaseUrl(GATEWAY)}/v1/messages`).toBe(`${GATEWAY}/anthropic/v1/messages`);
  });

  it("does not return the bare gateway root", () => {
    // The regression. Handing the root to the SDK produces /v1/messages, which
    // is registered under no endpoint prefix — the OpenAI-shaped set at the
    // root has no `messages` member. The model name is never extracted from
    // the body, no route rule matches, and every classification and status
    // draft fails while the Gateway reports healthy.
    expect(anthropicBaseUrl(GATEWAY)).not.toBe(GATEWAY);
  });

  it("does not double the separator when the endpoint has a trailing slash", () => {
    expect(anthropicBaseUrl(`${GATEWAY}/`)).toBe(`${GATEWAY}/anthropic`);
  });
});
