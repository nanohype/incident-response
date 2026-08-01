# Evals

Tests assert that code does what it says. Evals measure whether a **model**
does, on these prompts — and the answer is a rate, not a boolean.

| | Command | Needs a model | Every PR | Answers |
| --- | --- | --- | --- | --- |
| **Offline** | `npm run test:unit` | no | yes | Is the golden set still a golden set? |
| **Model** | `npm run eval` | yes | own workflow | Does Haiku / Sonnet hold up? |

```sh
MODEL_GATEWAY_ENDPOINT=http://localhost:1975 EVAL_LLM=gateway npm run eval
```

`EVAL_LLM` unset skips; set means it **must** run.

Both suites reach the model the way the product does — the Anthropic Messages
API against a ModelGateway, which is the app's only model path. In cluster that
endpoint is the one the operator publishes. Outside it, run upstream's
standalone `aigw`, which serves 1975:

```sh
node scripts/render-eval-gateway.mjs > /tmp/aigw.yaml
aigw run /tmp/aigw.yaml
```

The config is generated from `platform.yaml`, so the routes and model ids are
the ones this app deploys rather than a second copy that drifts. CI does
exactly this — see `evals.yml`.

## Suites

- **`fixtures/classifier.json`** — Haiku `classifyAsStatusUpdate`. Capability
  covers true and false status language; adversarial tries to force `true`
  via instruction text and tag smuggling. Graded on the structured boolean
  the product actually consumes.
- **`fixtures/status-draft.json`** — Sonnet `generateStatusDraft`. Capability
  is calm, generic customer language; adversarial is injection via alert
  title / IC message, reserved-tag smuggling, and seeded customer identifiers
  that the system prompt forbids.

Capability scores as a rate against `capabilityFloor`. Adversarial is 100%
per case.

## Fence

Untrusted inputs are fenced in `src/ai/incident-response-ai.ts` via
`src/vendor/runtime/guardrails.ts` before they reach Bedrock. The eval is
the measurement of whether the model holds the line given that fence.
