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
    // The model gateway endpoint has no default in config — there is no sensible
    // one, since the operator derives it from the Platform name. Supplied here so
    // every suite that imports the config can load it; the cases that assert on
    // its absence clear it themselves.
    env: {
      MODEL_GATEWAY_ENDPOINT: "http://gw.tenants-x.svc.cluster.local:8080",
      // `awsRegion()` has no default and throws when unset, and
      // handlers/webhook-ingress constructs its clients at module load — so
      // importing it needs a region present. Set here rather than left to the
      // shell: CI exports AWS_REGION and a developer shell usually does not,
      // and a suite that passes in one and fails in the other is worse than
      // either outcome. The value is arbitrary; nothing here reaches AWS.
      AWS_REGION: "us-east-1",
    },
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
        // `coverage.include` above makes the suite measure every file under
        // src/, so an untested module counts against the denominator instead
        // of being invisible to it. These sit just under measured so a
        // regression fails while ordinary movement does not.
        //
        // Statements, lines and branches all clear the org floor. Functions is
        // the one still under it, and where it sits is a function of two
        // different things worth separating.
        //
        // Ordinary gaps, which more tests would close: the Slack adapter
        // (src/adapters, 0%) and the per-subcommand handlers (src/commands,
        // 30.76% functions).
        //
        // Composition roots — index.ts, wiring/dependencies.ts and
        // bin/webhook-server.ts — are deliberately NOT unit-tested, and that is
        // a decision rather than a backlog item. A composition root's job is
        // wiring; a unit test that simulates a boot to reach one asserts the
        // shape of the wiring rather than any behaviour, and goes green when
        // the wiring is wrong in a way the test also encodes. That raises the
        // number without raising confidence, which is the failure the Testing
        // Trophy shape exists to avoid. They are verified by the tiers that
        // actually boot the process: the integration suite and the scripted
        // drill (scripts/fire-drill.sh, scripts/ci-drill.sh).
        //
        // They stay inside `coverage.include` regardless. Excluding them would
        // move these numbers by converting a visible, explained gap into an
        // invisible one, and the point of measuring every file under src/ is
        // that the denominator tells the truth.
        branches: 72, // measured 72.62 — clears the org floor of 60
        functions: 72, // measured 72.79 — the one still under its floor of 75
        lines: 79, // measured 79.69 — clears the org floor of 75
        statements: 78, // measured 78.35 — clears the org floor of 75

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
