/**
 * Client-facing base URLs on the Platform's ModelGateway.
 *
 * `MODEL_GATEWAY_ENDPOINT` is the gateway root. The gateway serves each
 * client-facing API under its own prefix, so the root on its own is not a
 * usable base URL for every client — which prefix applies depends on the wire
 * format being spoken, not on the model behind the route.
 *
 * Its own module rather than part of `./index.js`: that module parses the
 * process environment at import and exits when it is incomplete, which a unit
 * test cannot import.
 */

/**
 * The gateway's native Anthropic Messages base URL.
 *
 * The OpenAI-shaped endpoints sit at the gateway root; native Anthropic
 * Messages is served at `POST /anthropic/v1/messages`.
 *
 * The Anthropic SDK appends `/v1/messages` to whatever base URL it is given,
 * so it has to be handed the `/anthropic` prefix. Pointed at the root it would
 * request `/v1/messages`, which the gateway routes nowhere: the model name is
 * extracted from the request body by a processor registered per endpoint path,
 * so an unregistered path never gets the `x-ai-eg-model` header the route
 * rules match on. Every call fails, while the Gateway reports healthy.
 */
export function anthropicBaseUrl(gatewayEndpoint: string): string {
  // Trailing slash trimmed so the joined path cannot end up doubled.
  return `${gatewayEndpoint.replace(/\/+$/, "")}/anthropic`;
}
