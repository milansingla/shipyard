export type LogStream = "stdout" | "stderr";

export interface LogChunk {
  stream: LogStream;
  text: string;
}

const HEADER_SIZE = 8;

/**
 * Decodes Docker's multiplexed log format (used for containers without a TTY).
 *
 * Each frame: [stream type: 1 byte][0,0,0][payload size: uint32 big-endian][payload]
 *   stream type 1 = stdout, 2 = stderr
 *
 * V0.1 called `buffer.toString()` on this, which leaked the binary headers
 * into the output as garbage characters.
 */
export function demuxDockerLogs(buffer: Buffer): LogChunk[] {
  if (!looksMultiplexed(buffer)) {
    return buffer.length > 0 ? [{ stream: "stdout", text: buffer.toString("utf8") }] : [];
  }

  const chunks: LogChunk[] = [];
  let offset = 0;

  while (offset + HEADER_SIZE <= buffer.length) {
    const type = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + HEADER_SIZE;
    const end = Math.min(start + size, buffer.length);

    chunks.push({ stream: type === 2 ? "stderr" : "stdout", text: buffer.toString("utf8", start, end) });
    offset = start + size;
  }

  return chunks;
}

function looksMultiplexed(buffer: Buffer): boolean {
  if (buffer.length < HEADER_SIZE) return false;
  const type = buffer[0];
  return (type === 0 || type === 1 || type === 2) && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0;
}

export function formatLogChunks(chunks: readonly LogChunk[]): string {
  return chunks.map((chunk) => chunk.text).join("");
}
