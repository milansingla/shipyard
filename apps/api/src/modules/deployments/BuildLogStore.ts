import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";

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
  /** Logs being written by this process right now. */
  private readonly writing = new Set<string>();

  constructor(
    dataDir: string,
    private readonly keepBytes = 2 * 1024 * 1024,
    private readonly hardLimitBytes = 20 * 1024 * 1024,
  ) {
    this.dir = path.join(dataDir, "logs");
  }

  async open(deploymentId: string): Promise<BuildLogWriter> {
    await fsp.mkdir(this.dir, { recursive: true });
    const writer = new BuildLogWriter(this.pathFor(deploymentId), this.keepBytes, this.hardLimitBytes, () =>
      this.writing.delete(deploymentId),
    );
    this.writing.add(deploymentId);
    return writer;
  }

  /**
   * Streams the log as it is written, like `tail -f`: everything so far, then
   * new bytes every `pollMs`, until the build is over (its writer closed).
   * Reads the file by byte offset, so it doesn't depend on being in the
   * process that writes it. Multi-byte characters split across reads are
   * decoded correctly.
   */
  async follow(deploymentId: string, onText: (text: string) => void, signal: AbortSignal, pollMs = 500): Promise<void> {
    const file = this.pathFor(deploymentId);
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    while (!signal.aborted) {
      const active = this.writing.has(deploymentId); // checked before reading, so the last read sees the final bytes
      const chunk = await readFrom(file, offset);
      if (chunk === null) return; // trimmed when the build ended: the rest is in the stored log
      if (chunk.length > 0) {
        offset += chunk.length;
        onText(decoder.write(chunk));
      }
      if (!active) {
        const rest = decoder.end();
        if (rest) onText(rest);
        return;
      }
      await sleep(pollMs, undefined, { signal }).catch(() => {});
    }
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

/** Bytes from `offset` to the end; empty if the file doesn't exist yet; null if it shrank below `offset`. */
async function readFrom(file: string, offset: number): Promise<Buffer | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size < offset) return null;
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    return buffer;
  } finally {
    await handle.close();
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
    private readonly onClosed: () => void = () => {},
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
    try {
      await new Promise<void>((resolve, reject) => {
        this.stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
      await this.trimToTail();
    } finally {
      this.onClosed();
    }
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
