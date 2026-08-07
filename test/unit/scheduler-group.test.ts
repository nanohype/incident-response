import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The schedule group this app writes into must be the one the operator creates
 * and scopes the tenant's IAM grant to.
 *
 * Nothing joins the two sides. eks-agent-platform composes the group name as
 * `<env>-<platform>` and grants `schedule/<env>-<platform>/*`; this chart passes
 * a group name through as a plain string. When they disagreed — the chart said
 * `incident-response-<env>-nudges`, which nothing anywhere created — every
 * CreateSchedule failed, `NudgeScheduler.scheduleNudge` caught it, logged
 * "nudges will not fire for this incident" at warn, and returned normally. The
 * 15-minute status nudge never fired in any environment for the whole life of
 * the feature, and no gate could see it: the manifest was valid, the deployment
 * was healthy, and the only evidence was a warn line in a pod log.
 *
 * This asserts the composition rule rather than the literal, so it stays true if
 * a new environment is added.
 */
const CHART = join(process.cwd(), "chart");
const PLATFORM_NAME = "incident-response";
const ENVIRONMENTS = ["development", "staging", "production"] as const;

function tenantInfra(file: string): Record<string, unknown> {
  const doc = parse(readFileSync(join(CHART, file), "utf8")) as {
    tenantInfra?: Record<string, unknown>;
  };
  return doc.tenantInfra ?? {};
}

describe("scheduler group name", () => {
  it.each(ENVIRONMENTS)("values-%s.yaml names the group the operator creates", (env) => {
    const got = tenantInfra(`values-${env}.yaml`).schedulerGroupName;
    // The operator's scheduleGroupName(): `<env>-<platform>`, the same shape
    // every other tenant-scoped AWS name in this system composes to.
    expect(got).toBe(`${env}-${PLATFORM_NAME}`);
  });

  it("leaves the base chart's group empty so an unset environment fails loudly", () => {
    // An inherited default here would be worse than nothing: a group name that
    // looks plausible and belongs to no tenant produces the exact silent
    // failure this test exists to prevent.
    expect(tenantInfra("values.yaml").schedulerGroupName).toBe("");
  });

  it("never reintroduces a group name the operator does not create", () => {
    for (const env of ENVIRONMENTS) {
      const got = String(tenantInfra(`values-${env}.yaml`).schedulerGroupName);
      expect(got).not.toBe("default");
      expect(got.endsWith("-nudges")).toBe(false);
      // The grant is `schedule/<group>/*`, an exact match on the path segment.
      // A group whose name merely starts with the tenant's is a different group.
      expect(got.startsWith(`${env}-${PLATFORM_NAME}`)).toBe(true);
      expect(got).toHaveLength(`${env}-${PLATFORM_NAME}`.length);
    }
  });
});
