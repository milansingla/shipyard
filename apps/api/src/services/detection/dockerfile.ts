import fs from "node:fs/promises";
import path from "node:path";

/** Port assumed when a Dockerfile has no usable EXPOSE instruction (V0.1 behaviour). */
export const DEFAULT_CONTAINER_PORT = 3000;

export const DOCKERFILE_NAME = "Dockerfile";

export interface DockerfileInfo {
  path: string;
  /** Port from the last `EXPOSE` instruction, or null when absent/unparseable. */
  exposedPort: number | null;
}

/**
 * Looks for <sourceDir>/Dockerfile. Returns null when it does not exist.
 * Only a regular file counts — a symlink named Dockerfile is ignored so a
 * repository cannot trick Shipyard into reading files outside the clone.
 */
export async function detectDockerfile(sourceDir: string): Promise<DockerfileInfo | null> {
  const dockerfilePath = path.join(sourceDir, DOCKERFILE_NAME);

  let stats;
  try {
    stats = await fs.lstat(dockerfilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile()) return null;

  const contents = await fs.readFile(dockerfilePath, "utf8");
  return { path: dockerfilePath, exposedPort: parseExposedPort(contents) };
}

/**
 * Extracts the port from the LAST `EXPOSE` instruction. In multi-stage builds
 * only the final stage produces the runtime image, and it is usually last.
 * Variable forms like `EXPOSE ${PORT}` cannot be resolved statically → null.
 */
export function parseExposedPort(dockerfile: string): number | null {
  const matches = [...dockerfile.matchAll(/^\s*EXPOSE\s+(\S+)/gim)];
  const last = matches.at(-1)?.[1];
  if (last === undefined) return null;

  const portMatch = /^(\d{1,5})(?:\/tcp)?$/i.exec(last);
  if (!portMatch?.[1]) return null;

  const port = Number(portMatch[1]);
  return port >= 1 && port <= 65535 ? port : null;
}
