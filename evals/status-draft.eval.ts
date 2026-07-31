import { beforeAll, describe, expect, it } from "vitest";
import { IncidentResponseAI, isDegradedStatusDraft } from "../src/ai/incident-response-ai.js";
import { type GradeResult, gradeDraft, loadDraftSuite, score, toAlert } from "./harness.js";

// Model tier for Sonnet status drafts.
// EVAL_LLM unset → skip; set → must run.

const suite = loadDraftSuite();
const configured = (process.env.EVAL_LLM ?? "").trim();
const GATEWAY = process.env.MODEL_GATEWAY_ENDPOINT ?? "";

describe.skipIf(configured === "")(`eval: ${suite.name}`, () => {
  const results = new Map<string, GradeResult>();

  beforeAll(async () => {
    if (configured !== "gateway") {
      throw new Error(
        `EVAL_LLM="${configured}" is not supported here — status drafts go through the Anthropic ` +
          `Messages API to a ModelGateway. Use EVAL_LLM=gateway, or unset it to skip the model ` +
          `tier.`,
      );
    }
    if (GATEWAY === "") {
      // Checked once here: without it every case fails with the same
      // connection error, which reads as the model failing rather than as
      // missing config.
      throw new Error(
        'EVAL_LLM="gateway" requires MODEL_GATEWAY_ENDPOINT — the base URL of a reachable ' +
          "ModelGateway. In cluster that is the operator-published endpoint; outside it, run " +
          "upstream's standalone `aigw` and point at that.",
      );
    }
    const ai = new IncidentResponseAI(GATEWAY);
    const queue = [...suite.cases];
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        try {
          const text = await ai.generateStatusDraft(
            toAlert(c.input),
            undefined,
            c.input.icMessage,
            `eval-${c.id}`,
          );
          // generateStatusDraft swallows a provider failure and returns a
          // template. That is correct in production — an IC mid-P1 still gets
          // something to edit — but here it would score a clean pass against a
          // dead provider, because the template clears every band, satisfies
          // every `mentions`, and carries none of the `absent` markers. The
          // tier's contract is that EVAL_LLM set means a broken provider is a
          // hard failure, so the degraded draft is graded as one.
          results.set(
            c.id,
            isDegradedStatusDraft(text)
              ? {
                  passed: false,
                  failures: [
                    {
                      check: "degraded",
                      detail:
                        "generateStatusDraft returned its provider-failure template, so no model " +
                        "output was measured — check Bedrock reachability and the model pin",
                    },
                  ],
                }
              : gradeDraft(c.expect, { text }),
          );
        } catch (err) {
          results.set(c.id, {
            passed: false,
            failures: [
              {
                check: "mentions",
                detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          });
        }
      }
    });
    await Promise.all(workers);
  }, 300_000);

  for (const c of suite.cases.filter((x) => x.kind === "adversarial")) {
    it(`holds the line: ${c.id}`, () => {
      const r = results.get(c.id);
      expect(r, `${c.id} produced no result`).toBeDefined();
      const why = (r?.failures ?? []).map((f) => `${f.check}: ${f.detail}`).join("; ");
      expect(`${c.id} — ${why}`, `\n${c.rationale}\n`).toBe(`${c.id} — `);
    });
  }

  it("meets the capability floor", () => {
    const s = score(suite.cases, results);
    const failed = suite.cases
      .filter((c) => c.kind === "capability" && !results.get(c.id)?.passed)
      .map((c) => {
        const why = (results.get(c.id)?.failures ?? [])
          .map((f) => `${f.check}: ${f.detail}`)
          .join("; ");
        return `  ${c.id} — ${why}`;
      });
    expect(
      s.capability.rate,
      `capability ${s.capability.passed}/${s.capability.total}` +
        (failed.length ? `\nfailed:\n${failed.join("\n")}` : ""),
    ).toBeGreaterThanOrEqual(suite.capabilityFloor);
  });

  it("ran every case", () => {
    expect(results.size).toBe(suite.cases.length);
  });
});
