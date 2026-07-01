/**
 * Vitest configuration for IncidentResponse — unit suite.
 *
 * Coverage is always on so `npm run test:unit` enforces the thresholds
 * locally exactly as CI does (the README regression experiment depends on
 * a threshold violation exiting 1). Only files loaded by the tests are
 * measured — matching the gate the thresholds were calibrated against.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    testTimeout: 30000,
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        // Global thresholds reflect realistic coverage of untested service/client
        // modules (follow-up issue tracks expanding unit-test surface to 85/80 per
        // the audit). Falsification-tested in CI via the regression experiment
        // documented in README.md.
        branches: 55,
        functions: 75,
        lines: 75,
        statements: 75,
        // Security-critical files require 100% branch coverage. These thresholds
        // are load-bearing — they gate the approval-gate invariant and audit
        // integrity.
        'src/utils/audit.ts': {
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/services/statuspage-approval-gate.ts': {
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
