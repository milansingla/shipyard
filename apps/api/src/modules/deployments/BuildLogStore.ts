import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode } from "../../lib/errors.js";

/**
 * Stores each deployment's build log (Shipyard messages + `docker build`
 * output + the crash output of a failed start) as a plain file:
 *
 *   <dataDir>/logs/<deploymentId>.log
 *
 * Why files and not PostgreSQL? Build output is large, append-only and
 * written line by line. Thousands of tiny UPDATEs per build would bloat the
 * table; a file append is cheap. The database keeps the *metadata* (status,
 * errorMessage), so a lost log file never loses the reason a deploy failed.
 *
 * Size policy: writing stops at `hardLimitBytes` (protects the disk from a
 * build that prints forever). On close the file is trimmed to its LAST
 * `keepBytes`, because the end of a build log is where the error is.
 */
export class BuildLogStore {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly keepBytes = 2 * 1024 * 1024,
    private readonly hardLimitBytes = 20 * 1024 * 1024,
  ) {
    this.dir = path.join(dataDir, "logs");
  }

  async open(deploymentId: string): Promise<BuildLogWriter> {
    await fsp.mkdir(this.dir, { recursive: true });
    return new BuildLogWriter(this.pathFor(deploymentId), this.keepBytes, this.hardLimitBytes);
  }

  /** Returns "" when no log exists (e.g. the deployment never started). */
  async read(deploymentId: string): Promise<string> {
    try {
      return await fsp.readFile(this.pathFor(deploymentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async remove(deploymentId: string): Promise<void> {
    await fsp.rm(this.pathFor(deploymentId), { force: true });
  }

  private pathFor(deploymentId: string): string {
    // Ids are UUIDs; anything else could be a path-traversal attempt.
    if (!/^[0-9a-f-]{36}$/i.test(deploymentId)) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, `Invalid deployment id for log path: ${deploymentId}`);
    }
    return path.join(this.dir, `${deploymentId}.log`);
  }
}

export class BuildLogWriter {
  private readonly stream: fs.WriteStream;
  private bytesWritten = 0;
  private limitReached = false;

  constructor(
    private readonly filePath: string,
    private readonly keepBytes: number,
    private readonly hardLimitBytes: number,
  ) {
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
  }

  write(text: string): void {
    if (this.limitReached) return;
    const bytes = Buffer.byteLength(text);
    if (this.bytesWritten + bytes > this.hardLimitBytes) {
      this.limitReached = true;
      this.stream.write(`\n[shipyard] Log exceeded ${this.hardLimitBytes} bytes; further output discarded.\n`);
      return;
    }
    this.bytesWritten += bytes;
    this.stream.write(text);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    await this.trimToTail();
  }

  private async trimToTail(): Promise<void> {
    const { size } = await fsp.stat(this.filePath);
    if (size <= this.keepBytes) return;

    const handle = await fsp.open(this.filePath, "r");
    let tail: Buffer;
    try {
      tail = Buffer.alloc(this.keepBytes);
      await handle.read(tail, 0, this.keepBytes, size - this.keepBytes);
    } finally {
      await handle.close();
    }
    const header = `[shipyard] Showing the last ${this.keepBytes} bytes of ${size}.\n`;
    await fsp.writeFile(this.filePath, Buffer.concat([Buffer.from(header), tail]));
  }
}
