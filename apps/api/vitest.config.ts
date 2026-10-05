import { defineConfig } from "vitest/config";

// Unit tests: fast, no Docker, no network.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
    environment: "node",
  },
});
