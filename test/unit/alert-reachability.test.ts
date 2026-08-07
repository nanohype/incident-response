import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DurationBuckets, MetricNames } from "../../src/utils/metrics.js";

/**
 * Every duration alert threshold sits inside its histogram's bucket range.
 *
 * `histogram_quantile` cannot return a value above the highest finite bucket
 * edge. An alert thresholded past that edge is not imprecise — it is FALSE FOR
 * EVERY POSSIBLE INPUT, and reports a healthy service forever.
 *
 * IncidentResponseAssemblyDurationBreach was exactly that. The instrument set no
 * explicit boundaries, so it inherited OTel's defaults topping out at 10000; the
 * alert compared p99 against 300000. Thirty times the top edge. It could never
 * have fired, in any environment, at any latency — and every gate in this repo
 * stayed green, because the manifest was valid, the metric existed and the rule
 * parsed.
 *
 * This is the assertion that would have caught it, and it is deliberately about
 * the NUMBER rather than the name: renaming `_ms` to `_seconds` would have left
 * the alert just as dead.
 */
const CHART = join(process.cwd(), "chart");

// OTel's default explicit bucket boundaries, applied when an instrument declares
// none. Reproduced here because the whole failure was not knowing them.
const OTEL_DEFAULT_TOP_EDGE = 10000;

type Rule = { alert?: string; expr?: string };

/**
 * Read the rules out of the raw template text.
 *
 * The manifest is a Helm template, so it is not parseable YAML — and rendering
 * it here would make this test depend on a helm binary. The `alert:` and `expr:`
 * lines carry no Go templating, so a line scan reads exactly what ships.
 */
function alertRules(): Rule[] {
  const text = readFileSync(join(CHART, "templates", "prometheusrule.yaml"), "utf8");
  const out: Rule[] = [];
  let current: Rule | null = null;
  for (const line of text.split("\n")) {
    const alert = /^\s*-?\s*alert:\s*(.+?)\s*$/.exec(line);
    if (alert) {
      if (current) out.push(current);
      current = { alert: alert[1] };
      continue;
    }
    const expr = /^\s*expr:\s*(.+?)\s*$/.exec(line);
    if (expr && current) current.expr = expr[1];
  }
  if (current) out.push(current);
  return out;
}

/** The `> N` comparison on a histogram_quantile expression, if there is one. */
function quantileThreshold(expr: string): { series: string; threshold: number } | null {
  if (!expr.includes("histogram_quantile")) return null;
  const series = /rate\(([a-z0-9_]+)_bucket\[/.exec(expr)?.[1];
  const threshold = /[>≥]=?\s*([0-9.]+)\s*$/.exec(expr.trim())?.[1];
  if (!series || threshold === undefined) return null;
  return { series, threshold: Number(threshold) };
}

// Series name -> the edges the instrument actually declares.
const DECLARED: Record<string, readonly number[]> = {
  [`incident_response_${MetricNames.AssemblyDuration}`]: DurationBuckets.assembly,
  [`incident_response_${MetricNames.ApprovalGateLatency}`]: DurationBuckets.approvalGate,
};

describe("duration alert reachability", () => {
  const rules = alertRules();

  it("parses the PrometheusRule at all", () => {
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.alert)).toBe(true);
  });

  it("finds at least one histogram_quantile threshold to check", () => {
    // Without this the assertion below passes by matching nothing, which is how
    // the original defect survived every gate in the repo.
    const found = rules.filter((r) => r.expr && quantileThreshold(r.expr));
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(
    rules.filter((r) => r.expr && quantileThreshold(r.expr!)).map((r) => [r.alert ?? "?", r]),
  )("%s thresholds inside its histogram's range", (_name, rule) => {
    const parsed = quantileThreshold((rule as Rule).expr!);
    expect(parsed).not.toBeNull();
    const { series, threshold } = parsed!;

    const edges = DECLARED[series];
    expect(
      edges,
      `${series} is alerted on but declares no explicit bucket edges here. It therefore ` +
        `inherits OTel's defaults, whose top edge is ${OTEL_DEFAULT_TOP_EDGE} — and any ` +
        `threshold above that can never be reached.`,
    ).toBeDefined();

    const top = edges[edges.length - 1];
    expect(
      threshold,
      `${(rule as Rule).alert} compares p99 of ${series} against ${threshold}, but the ` +
        `highest finite bucket edge is ${top}. histogram_quantile cannot return more than ` +
        `${top}, so this alert is false for every possible input.`,
    ).toBeLessThan(top);
  });
});
