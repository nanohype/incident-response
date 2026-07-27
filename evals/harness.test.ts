import { describe, expect, it } from "vitest";
import {
  gradeClassifier,
  gradeDraft,
  loadClassifierSuite,
  loadDraftSuite,
  score,
  toAlert,
  wordCount,
} from "./harness.js";

const classifier = loadClassifierSuite();
const drafts = loadDraftSuite();

describe("classifier golden set", () => {
  it("parses with unique ids and both kinds", () => {
    const ids = classifier.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(classifier.cases.map((c) => c.kind))).toEqual(
      new Set(["capability", "adversarial"]),
    );
  });

  it("covers both true and false capability outcomes", () => {
    // A set that only expects true measures nothing — always-true would score 100%.
    const truth = new Set(
      classifier.cases
        .filter((c) => c.kind === "capability")
        .flatMap((c) => c.expect.is_status_update),
    );
    expect(truth.has(true)).toBe(true);
    expect(truth.has(false)).toBe(true);
  });

  it("gives every adversarial case something falsifiable", () => {
    for (const c of classifier.cases.filter((x) => x.kind === "adversarial")) {
      const constrained = c.expect.absent.length > 0 || c.expect.is_status_update.length < 2;
      expect(constrained, `${c.id} can never fail`).toBe(true);
    }
  });

  it("sets a meaningful capability floor", () => {
    expect(classifier.capabilityFloor).toBeGreaterThanOrEqual(0.5);
  });
});

describe("status-draft golden set", () => {
  it("parses with unique ids and both kinds", () => {
    const ids = drafts.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(drafts.cases.map((c) => c.kind))).toEqual(
      new Set(["capability", "adversarial"]),
    );
  });

  it("gives every adversarial case absent markers", () => {
    for (const c of drafts.cases.filter((x) => x.kind === "adversarial")) {
      expect(c.expect.absent.length, `${c.id} can never fail`).toBeGreaterThan(0);
    }
  });

  it("toAlert carries title and team", () => {
    const a = toAlert(drafts.cases[0].input);
    expect(a.alert_group.title).toBe(drafts.cases[0].input.title);
    expect(a.team_name).toBe(drafts.cases[0].input.team);
  });
});

describe("gradeClassifier", () => {
  it("passes a matching classification", () => {
    expect(
      gradeClassifier(
        { is_status_update: [true], absent: [] },
        { is_status_update: true, confidence: 0.9 },
      ).passed,
    ).toBe(true);
  });

  it("fails wrong boolean and says what it got", () => {
    const r = gradeClassifier(
      { is_status_update: [false], absent: [] },
      { is_status_update: true, confidence: 0.9 },
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0].check).toBe("is_status_update");
  });

  it("catches absent markers in raw text", () => {
    const r = gradeClassifier(
      { is_status_update: [false], absent: ["PWNED"] },
      { is_status_update: false, confidence: 0.1, raw: "note: PWNED" },
    );
    expect(r.failures.some((f) => f.check === "absent")).toBe(true);
  });
});

describe("gradeDraft", () => {
  it("passes a clean draft", () => {
    expect(
      gradeDraft(
        { mentions: [["investigat"]], absent: ["Acme"], words: [5, 100] },
        {
          text: "We are investigating elevated errors for some customers. Updates every 30 minutes.",
        },
      ).passed,
    ).toBe(true);
  });

  it("fails forbidden identifiers", () => {
    const r = gradeDraft(
      { mentions: [], absent: ["AcmeCorp"], words: undefined },
      { text: "AcmeCorp is affected." },
    );
    expect(r.failures.some((f) => f.check === "absent")).toBe(true);
  });

  it("wordCount splits on whitespace", () => {
    expect(wordCount("  one two  three ")).toBe(3);
  });
});

describe("score", () => {
  const cases = [
    { id: "a", kind: "capability" as const },
    { id: "b", kind: "capability" as const },
    { id: "c", kind: "capability" as const },
    { id: "d", kind: "capability" as const },
    { id: "x", kind: "adversarial" as const },
    { id: "y", kind: "adversarial" as const },
  ];
  const results = (passing: string[]) =>
    new Map(cases.map((c) => [c.id, { passed: passing.includes(c.id), failures: [] }]));

  it("scores capability as a rate", () => {
    expect(score(cases, results(["a", "b", "c", "x", "y"])).capability).toEqual({
      passed: 3,
      total: 4,
      rate: 0.75,
    });
  });

  it("treats missing results as failures", () => {
    const s = score(cases, new Map());
    expect(s.capability.passed).toBe(0);
    expect(s.adversarial.passed).toBe(0);
  });
});
