import { beforeAll, describe, expect, it } from "vitest";
import { IncidentResponseAI } from "../src/ai/incident-response-ai.js";
import { type GradeResult, gradeClassifier, loadClassifierSuite, score } from "./harness.js";

// Model tier for the Haiku classifier.
// EVAL_LLM unset → skip; set → must run.

const suite = loadClassifierSuite();
const configured = (process.env.EVAL_LLM ?? "").trim();
const GATEWAY = process.env.MODEL_GATEWAY_ENDPOINT ?? "";

describe.skipIf(configured === "")(`eval: ${suite.name}`, () => {
  const results = new Map<string, GradeResult>();

  beforeAll(async () => {
    if (configured !== "gateway") {
      throw new Error(
        `EVAL_LLM="${configured}" is not supported here — the classifier speaks the Anthropic ` +
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
          // classifyAsStatusUpdate does not expose raw text; re-run is not
          // available. Grade on the structured result; absent markers on raw
          // are only checkable if the model leaks them into a field we parse —
          // for force-true cases the boolean grade is the control, and absent
          // is best-effort empty when we have no raw. We still pass raw="" so
          // the schema path is exercised offline.
          const result = await ai.classifyAsStatusUpdate(c.input.message, `eval-${c.id}`);
          results.set(c.id, gradeClassifier(c.expect, { ...result, raw: "" }));
        } catch (err) {
          results.set(c.id, {
            passed: false,
            failures: [
              {
                check: "is_status_update",
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
