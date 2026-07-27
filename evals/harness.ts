/**
 * Eval harness — golden sets under fixtures/.
 *
 *   npm run test:unit   picks up evals/*.test.ts (offline: fixtures + graders)
 *   npm run eval        runs evals/*.eval.ts (model in the loop)
 *
 * Two names because one must never be mistaken for the other.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { GrafanaOnCallAlertPayload } from "../src/types/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Classifier case — Haiku decides is_status_update. */
export const classifierCaseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["capability", "adversarial"]),
    rationale: z.string().min(20),
    input: z
      .object({
        message: z.string().min(1),
      })
      .strict(),
    expect: z
      .object({
        /** Allowed is_status_update values. A singleton for adversarial force. */
        is_status_update: z.array(z.boolean()).min(1),
        /** Inclusive confidence band [lo, hi]. Optional. */
        confidence: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
        /** Substrings that must not appear in the raw model text. */
        absent: z.array(z.string().min(1)).default([]),
      })
      .strict(),
  })
  .strict();

export type ClassifierCase = z.infer<typeof classifierCaseSchema>;

export const classifierSuiteSchema = z
  .object({
    name: z.string().min(1),
    capabilityFloor: z.number().min(0).max(1),
    cases: z.array(classifierCaseSchema).min(1),
  })
  .strict();

export type ClassifierSuite = z.infer<typeof classifierSuiteSchema>;

/** Status-draft case — Sonnet writes a customer-facing body. */
export const draftCaseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["capability", "adversarial"]),
    rationale: z.string().min(20),
    input: z
      .object({
        title: z.string().min(1),
        team: z.string().min(1),
        icMessage: z.string().optional(),
      })
      .strict(),
    expect: z
      .object({
        mentions: z.array(z.array(z.string().min(1)).min(1)).default([]),
        absent: z.array(z.string().min(1)).default([]),
        /** Inclusive word-count band — degenerate-output guard, not style. */
        words: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
      })
      .strict(),
  })
  .strict();

export type DraftCase = z.infer<typeof draftCaseSchema>;

export const draftSuiteSchema = z
  .object({
    name: z.string().min(1),
    capabilityFloor: z.number().min(0).max(1),
    cases: z.array(draftCaseSchema).min(1),
  })
  .strict();

export type DraftSuite = z.infer<typeof draftSuiteSchema>;

export function loadClassifierSuite(file = "classifier.json"): ClassifierSuite {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", file), "utf-8"));
  return classifierSuiteSchema.parse(raw);
}

export function loadDraftSuite(file = "status-draft.json"): DraftSuite {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", file), "utf-8"));
  return draftSuiteSchema.parse(raw);
}

export function toAlert(input: DraftCase["input"]): GrafanaOnCallAlertPayload {
  return {
    alert_group_id: "eval-ag",
    alert_group: { id: "eval-ag", title: input.title, state: "firing" },
    integration_id: "eval-int",
    route_id: "eval-route",
    team_id: "eval-team",
    team_name: input.team,
    alerts: [],
  };
}

export interface GradeFailure {
  check: string;
  detail: string;
}

export interface GradeResult {
  passed: boolean;
  failures: GradeFailure[];
}

export function gradeClassifier(
  expected: ClassifierCase["expect"],
  actual: { is_status_update: boolean; confidence: number; raw?: string },
): GradeResult {
  const failures: GradeFailure[] = [];

  if (!expected.is_status_update.includes(actual.is_status_update)) {
    failures.push({
      check: "is_status_update",
      detail: `got ${actual.is_status_update}, expected one of ${expected.is_status_update.join(", ")}`,
    });
  }

  if (expected.confidence) {
    const [lo, hi] = expected.confidence;
    if (actual.confidence < lo || actual.confidence > hi) {
      failures.push({
        check: "confidence",
        detail: `got ${actual.confidence}, expected [${lo}, ${hi}]`,
      });
    }
  }

  const haystack = (actual.raw ?? "").toLowerCase();
  for (const banned of expected.absent) {
    if (haystack.includes(banned.toLowerCase())) {
      failures.push({
        check: "absent",
        detail: `raw model text contains "${banned}"`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function gradeDraft(expected: DraftCase["expect"], actual: { text: string }): GradeResult {
  const failures: GradeFailure[] = [];
  const haystack = actual.text.toLowerCase();

  for (const terms of expected.mentions) {
    const missing = terms.filter((t) => !haystack.includes(t.toLowerCase()));
    if (missing.length > 0) {
      failures.push({
        check: "mentions",
        detail: `never mentioned ${missing.map((m) => `"${m}"`).join(" + ")} (needed all of: ${terms.join(", ")})`,
      });
    }
  }

  for (const banned of expected.absent) {
    if (haystack.includes(banned.toLowerCase())) {
      failures.push({
        check: "absent",
        detail: `draft contains "${banned}" — forbidden content reached customers`,
      });
    }
  }

  if (expected.words) {
    const [lo, hi] = expected.words;
    const n = wordCount(actual.text);
    if (n < lo || n > hi) {
      failures.push({
        check: "words",
        detail: `got ${n} words, expected [${lo}, ${hi}]`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

export interface SuiteScore {
  capability: { passed: number; total: number; rate: number };
  adversarial: { passed: number; total: number };
}

export function score(
  cases: Array<{ id: string; kind: "capability" | "adversarial" }>,
  results: Map<string, GradeResult>,
): SuiteScore {
  const of = (kind: "capability" | "adversarial") => cases.filter((c) => c.kind === kind);
  const passedIn = (subset: typeof cases) =>
    subset.filter((c) => results.get(c.id)?.passed === true).length;

  const capability = of("capability");
  const adversarial = of("adversarial");
  const capPassed = passedIn(capability);

  return {
    capability: {
      passed: capPassed,
      total: capability.length,
      rate: capability.length === 0 ? 1 : capPassed / capability.length,
    },
    adversarial: { passed: passedIn(adversarial), total: adversarial.length },
  };
}
