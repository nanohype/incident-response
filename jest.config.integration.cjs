/**
 * Integration tests run against a live dynamodb-local Docker container.
 *
 * Locally:  docker run -d -p 8000:8000 amazon/dynamodb-local
 * In CI:    GitHub Actions `services:` block (see .github/workflows/ci.yml)
 *
 * The test bootstrap points DynamoDBClient at http://localhost:8000 with dummy creds.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.integration.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs', esModuleInterop: true } }],
  },
  testTimeout: 60000,
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
