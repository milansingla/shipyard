import { defineConfig } from "vitest/config";

// Integration tests: talk to the real Docker daemon, PostgreSQL (shipyard_test) and the network.
// Requires: Docker running and `npm run db:up`.
// Slow by nature (image builds), so timeouts are generous.
export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    environment: "node",
    globalSetup: ["test/integration/globalSetup.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
