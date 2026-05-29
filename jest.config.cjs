/**
 * Jest configuration for Marshal.
 * Two test suites: unit (fast, no external deps) and integration (DynamoDB local).
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        esModuleInterop: true,
      },
    }],
  },
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    // Global thresholds reflect realistic coverage of untested service/client modules
    // (follow-up issue tracks expanding unit-test surface to 85/80 per the audit).
    // Falsification-tested in CI via the regression experiment documented in README.md.
    global: {
      branches: 55,
      functions: 75,
      lines: 75,
      statements: 75,
    },
    // Security-critical files require 100% branch coverage. These thresholds are
    // load-bearing — they gate the approval-gate invariant and audit integrity.
    './src/utils/audit.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
    },
    './src/services/statuspage-approval-gate.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
  testTimeout: 30000,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
