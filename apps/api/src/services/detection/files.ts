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

export interface DirectoryEntry {
  name: string;
  kind: "file" | "directory";
}

/**
 * Regular files and real directories directly inside `dir`, sorted by name,
 * at most `limit`. Symlinks and anything else are left out, so a scan never
 * leaves the clone. A missing directory is empty.
 */
export async function listEntries(dir: string, limit = 2000): Promise<DirectoryEntry[]> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const entries: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.isFile()) entries.push({ name: dirent.name, kind: "file" });
    else if (dirent.isDirectory()) entries.push({ name: dirent.name, kind: "directory" });
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).slice(0, limit);
}

/**
 * A relative path inside the repository, safe to use as a directory and to
 * write into a generated Dockerfile: plain segments only (no "..", no
 * absolute paths, no spaces or shell characters), "." for the root.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === ".") return true;
  if (value.length > 200) return false;
  return value.split("/").every((segment) => /^[A-Za-z0-9_@+-][A-Za-z0-9_@.+-]*$/.test(segment) && segment !== "." && segment !== "..");
}

/** True when every directory on the way to `relative` (inside `dir`) is a real directory, not a symlink. */
async function realDirectories(dir: string, relative: string): Promise<boolean> {
  const segments = relative.split("/").slice(0, -1);
  let current = dir;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (!(await fs.lstat(current)).isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

/** readRegularFile for a nested path ("app/main.py"): no symlinked file or directory on the way. */
export async function readNestedFile(dir: string, relative: string, maxBytes: number): Promise<string | null> {
  if (!isSafeRelativePath(relative) || !(await realDirectories(dir, relative))) return null;
  return readRegularFile(dir, relative, maxBytes);
}

/** isRegularFile for a nested path, with the same guarantees as readNestedFile. */
export async function isNestedRegularFile(dir: string, relative: string): Promise<boolean> {
  if (!isSafeRelativePath(relative) || !(await realDirectories(dir, relative))) return false;
  return isRegularFile(dir, relative);
}

/** A real directory (not a symlink) at a nested path inside `dir`. */
export async function isNestedDirectory(dir: string, relative: string): Promise<boolean> {
  if (relative === ".") return true;
  if (!isSafeRelativePath(relative) || !(await realDirectories(dir, `${relative}/x`))) return false;
  return true;
}
