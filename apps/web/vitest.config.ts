import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests for the dashboard's pure logic (status model, formatting, API client).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
