import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The release-age floor in `.npmrc` fails open. A misspelled key draws an
 * "Unknown project config" warning and npm resolves with no floor at all, and
 * so does a value of 0. A `before` line beside `min-release-age` takes
 * precedence over it, or stops npm from starting, depending on the npm release.
 * None of these shows up anywhere else: `npm ci` installs the committed lockfile
 * without consulting the floor, so every other gate stays green while the floor
 * is gone.
 *
 * The parse covers the subset of ini syntax this file uses: one `key=value` per
 * line, and comment lines that start with `#` or `;`.
 */
const settings = readFileSync(join(process.cwd(), ".npmrc"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith(";"))
  .map((line) => {
    const eq = line.indexOf("=");
    return eq === -1
      ? { key: line, value: "" }
      : { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() };
  });

describe(".npmrc release-age floor", () => {
  it("sets min-release-age once, to a number of days above zero", () => {
    const floors = settings.filter((s) => s.key === "min-release-age").map((s) => s.value);
    expect(floors).toHaveLength(1);
    expect(floors[0]).toMatch(/^\d+(\.\d+)?$/);
    expect(Number(floors[0])).toBeGreaterThan(0);
  });

  it("sets no before, which would override min-release-age", () => {
    expect(settings.map((s) => s.key)).not.toContain("before");
  });
});
