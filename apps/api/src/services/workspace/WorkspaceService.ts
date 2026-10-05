import fs from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode } from "../../lib/errors.js";

/**
 * Owns the directory where repositories are cloned. Every path it creates or
 * deletes is verified to live strictly inside `rootDir`, so a bad id can never
 * make Shipyard write to (or `rm -rf`) somewhere else on disk.
 */
export class WorkspaceService {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** Returns a fresh, not-yet-existing directory path for this deployment. */
  async prepare(deploymentId: string): Promise<string> {
    const dir = this.resolveInside(deploymentId);
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.rm(dir, { recursive: true, force: true });
    return dir;
  }

  async cleanup(dir: string): Promise<void> {
    const resolved = this.resolveInside(path.relative(this.rootDir, dir));
    await fs.rm(resolved, { recursive: true, force: true });
  }

  private resolveInside(relative: string): string {
    const resolved = path.resolve(this.rootDir, relative);
    if (path.dirname(resolved) !== this.rootDir) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, `Refusing to use path outside workspace: ${resolved}`);
    }
    return resolved;
  }
}
