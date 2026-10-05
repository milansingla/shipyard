import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TEST_DATABASE_URL, assertTestDatabase } from "../helpers/db.js";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Recreates the test database from the migrations before the integration suite. */
export default function setup(): void {
  assertTestDatabase(TEST_DATABASE_URL);
  execFileSync("npx", ["prisma", "migrate", "reset", "--force"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
