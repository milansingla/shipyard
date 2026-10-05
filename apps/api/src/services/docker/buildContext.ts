import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import dockerignoreModule from "@balena/dockerignore";

import { AppError, ErrorCode } from "../../lib/errors.js";

// A CommonJS package typed as an ES default export: under NodeNext the default
// import IS the factory function at runtime, but TypeScript sees `{ default }`.
const dockerignore = dockerignoreModule as unknown as typeof dockerignoreModule.default;

const MAX_DOCKERIGNORE_BYTES = 256 * 1024;

/**
 * Returns a predicate for tar-fs: true = leave this absolute path OUT of the
 * build context.
 *
 * Docker only honours .dockerignore when the *client* (the docker CLI) applies
 * it while creating the context tarball; the daemon does not. Shipyard is the
 * client here, so it must apply it itself — otherwise files a repository
 * deliberately excludes (.env, credentials, node_modules) end up in the image.
 * Semantics follow the docker CLI:
 *   - `.git` is always excluded (never needed, often large)
 *   - the Dockerfile in use and .dockerignore itself are always sent
 *   - `!exception` patterns can re-include files inside excluded directories
 */
export async function createContextFilter(contextDir: string, dockerfile: string): Promise<(absolutePath: string) => boolean> {
  const patterns = await readDockerignore(contextDir);
  const matcher = dockerignore({ ignorecase: false }).add(patterns);
  const hasExceptions = patterns.some((line) => line.trim().startsWith("!"));
  const alwaysKeep = new Set([toPosix(path.normalize(dockerfile)), ".dockerignore"]);

  return (absolutePath) => {
    const relative = toPosix(path.relative(contextDir, absolutePath));
    if (relative === "" || alwaysKeep.has(relative)) return false;
    if (relative.split("/")[0] === ".git") return true;

    // With exceptions, a file inside an excluded directory may be re-included,
    // so directories must be walked and each file decided on its own.
    if (hasExceptions && isDirectory(absolutePath)) return false;
    return matcher.ignores(relative);
  };
}

async function readDockerignore(contextDir: string): Promise<string[]> {
  const filePath = path.join(contextDir, ".dockerignore");
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // A symlinked .dockerignore could point outside the clone: ignore it.
  if (!stats.isFile()) return [];
  if (stats.size > MAX_DOCKERIGNORE_BYTES) {
    throw new AppError(ErrorCode.DOCKER_BUILD_FAILED, ".dockerignore is too large.", { statusCode: 422 });
  }
  return (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
}

function isDirectory(absolutePath: string): boolean {
  try {
    return fsSync.lstatSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}
