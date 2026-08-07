import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every test file this repo ships is one vitest actually collects.
 *
 * `src/config/gateway-url.test.ts` sat outside every configured include glob
 * for its whole life and was never run
 * once. It was not a stale file: it guards a live-proven regression — handing the SDK the
 * gateway root produces `/v1/messages`, which is registered under no endpoint
 * prefix, so every classification and status draft fails while the Gateway
 * reports healthy. Three assertions written specifically to catch that, and none
 * of them ever executed.
 *
 * Nothing could see it. `npm run test:unit` reported a passing suite over the
 * files it did collect, and a file that is never collected cannot fail. This is
 * the same shape as the defects the campaign that found it exists to close: a
 * control that is present, looks correct, and is wired to nothing.
 */
const ROOT = process.cwd();

// Mirrors the include globs of BOTH configs — vitest.config.ts (unit + evals)
// and vitest.config.integration.ts. Kept as literals rather than imported, so
// widening a config does not silently widen this assertion with it.
const COLLECTED_ROOTS = ["test/unit/", "evals/", "test/integration/"];

// Every config whose include globs the roots above claim to mirror. A new
// config file that nothing here knows about is the next instance of this bug.
const CONFIGS = ["vitest.config.ts", "vitest.config.integration.ts"];

const IGNORED = ["node_modules/", ".git/", "dist/", "coverage/"];

describe("test collection", () => {
  it("collects every *.test.ts in the repo", async () => {
    const stray: string[] = [];
    for await (const entry of glob("**/*.test.ts", { cwd: ROOT })) {
      const rel = entry.split("\\").join("/");
      if (IGNORED.some((i) => rel.startsWith(i) || rel.includes(`/${i}`))) continue;
      if (!COLLECTED_ROOTS.some((r) => rel.startsWith(r))) stray.push(rel);
    }

    expect(
      stray,
      `these test files are outside vitest's include globs (${COLLECTED_ROOTS.join(", ")}), ` +
        "so they are never run and can never fail. Move them under test/unit/ or widen the config.",
    ).toEqual([]);
  });

  it("is not asserting over an empty set", async () => {
    // A glob that matches nothing passes the assertion above trivially, which is
    // exactly how this check would stop checking.
    let found = 0;
    for await (const entry of glob("test/unit/**/*.test.ts", { cwd: ROOT })) {
      void entry;
      found++;
    }
    expect(found).toBeGreaterThan(10);
  });

  it("names the collected roots that vitest actually configures", () => {
    // If the config's include list moves and this literal does not, the first
    // assertion starts measuring against the wrong target.
    const configured = CONFIGS.map((c) => readFileSync(join(ROOT, c), "utf8")).join("\n");
    for (const root of COLLECTED_ROOTS) {
      expect(
        configured,
        `${root} is claimed as a collected root but no vitest config includes it`,
      ).toContain(root.replace(/\/$/, ""));
    }
  });
});
