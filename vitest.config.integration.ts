/**
 * Integration tests run against a live dynamodb-local Docker container.
 *
 * Locally:  docker run -d -p 8000:8000 amazon/dynamodb-local
 * In CI:    GitHub Actions `services:` block (see .github/workflows/ci.yml)
 *
 * The test bootstrap (test/integration/setup.ts) points DynamoDBClient at
 * http://localhost:8000 with dummy creds and destroys the client after the
 * run so the process exits cleanly.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Same reason as the unit config: MODEL_GATEWAY_ENDPOINT has no default,
    // and the wiring these tests exercise loads the app config.
    env: {
      MODEL_GATEWAY_ENDPOINT: "http://gw.tenants-x.svc.cluster.local:8080",
    },
    include: ["test/integration/**/*.integration.test.ts"],
    testTimeout: 60000,
  },
});
