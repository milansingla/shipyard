import fs from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode } from "../../lib/errors.js";

/**
 * True only for a regular file directly inside `dir`. Symlinks and directories
 * don't count, so a repository cannot point Shipyard at files outside the clone.
 */
export async function isRegularFile(dir: string, name: string): Promise<boolean> {
  try {
    return (await fs.lstat(path.join(dir, name))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Reads `<dir>/<name>` if it is a regular file (see isRegularFile), else null.
 * Files larger than `maxBytes` are rejected: repository content is untrusted.
 */
export async function readRegularFile(dir: string, name: string, maxBytes: number): Promise<string | null> {
  const filePath = path.join(dir, name);

  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile()) return null;
  if (stats.size > maxBytes) {
    throw new AppError(
      ErrorCode.PROJECT_DETECTION_FAILED,
      `${name} is larger than ${Math.round(maxBytes / 1024)} KB; refusing to read it.`,
      { statusCode: 422 },
    );
  }

  return fs.readFile(filePath, "utf8");
}
