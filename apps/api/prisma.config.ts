import path from "node:path";

import { defineConfig } from "prisma/config";

// Same .env the API reads (repo root). Real environment variables win.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Not required for `prisma generate`; migrate/studio fail clearly without it.
    url: process.env.DATABASE_URL ?? "",
  },
});
