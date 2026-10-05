import { defineConfig } from "vitest/config";

// Integration tests: talk to the real Docker daemon and the network.
// Slow by nature (image builds), so timeouts are generous.
export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
