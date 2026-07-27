/**
 * Vitest configuration for IncidentResponse — unit suite.
 *
 * Coverage is always on so `npm run test:unit` enforces the thresholds
 * locally exactly as CI does (the README regression experiment depends on
 * a threshold violation exiting 1). Only files loaded by the tests are
 * measured — matching the gate the thresholds were calibrated against.
 */
import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Offline eval tier (fixture validity + graders) lives under evals/ and
    // must run on every PR — the model half can be skipped.
    include: ["test/unit/**/*.test.ts", "evals/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov", "html"],
      // Explicit include so a module with zero tests still counts against the
      // floor. Without it v8 measures only what the suite happened to import,
      // which makes the gate vacuous in the one direction that matters: adding
      // an untested file would RAISE the percentage rather than lower it.
      include: ["src/**/*.ts"],
      // Vendored modules carry their coverage upstream (nanohype
      // library/runtime colocates full test suites) and are byte-identical by
      // CI gate — measuring them here would double-count logic this repo must
      // not modify. App-side wiring around them stays measured.
      exclude: [...coverageConfigDefaults.exclude, "src/vendor/**"],
      thresholds: {
        // These are a ratchet under the measured whole-source numbers, not the
        // org floor (branches 60 / functions 75 / lines 75 / statements 75 in
        // nanohype/standards/testing-rubric.json).
        //
        // They read lower than they used to and coverage did not fall: the
        // denominator was wrong. Without `coverage.include` above, v8 measured
        // only the modules the suite imported, so every untested service and
        // client was invisible to the gate and the old 75s were computed over
        // roughly half the source. Measured whole-source is 52.49 / 49.82 /
        // 46.37 / 54.12; these sit just under that so a regression fails while
        // ordinary movement does not.
        //
        // Raising them means writing tests for the untested service/client
        // modules, which is the real work the previous numbers concealed.
        branches: 48, // measured 49.82
        functions: 45, // measured 46.37
        lines: 53, // measured 54.12
        statements: 51, // measured 52.49

        // Per-file 100% on the security- and compliance-critical path, above the
        // global floor — the `security-critical-100` rule. These are not
        // ratchets: a branch never taken in a test is a control never proven,
        // and lowering one is a decision about what the product guarantees.
        //
        // `statements` is pinned alongside the other three. Its absence was a
        // real hole: a file can hold every branch and still gain an unexercised
        // statement, which on the approval gate is a write nothing asserts.

        // The gate that decides whether a status-page update reaches customers.
        "src/services/statuspage-approval-gate.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // The audit ledger, and the record that a decision was made at all.
        "src/utils/audit.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // Slack request signature verification — what separates a genuine
        // interaction from a forged POST. It measured 100 already and was not
        // pinned, so nothing stopped the next change lowering it.
        "src/handlers/slack-signature.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
        // The inbound webhook boundary: HMAC verification, the rotation-race
        // retry, and the fail-closed 500 when the signing secret cannot be
        // fetched at all. Secrets Manager being briefly unavailable must never
        // become a 200 for a request whose signature was never checked.
        "src/handlers/webhook-ingress.ts": {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
