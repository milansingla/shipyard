import semver from "semver";

import { readRegularFile } from "./files.js";
import { detectionError, truncate } from "./nodeProject.js";

/** Node majors with official `node:<major>-slim` images, newest first. */
export const SUPPORTED_NODE_MAJORS = [24, 22, 20] as const;
export const DEFAULT_NODE_MAJOR = 24;

/** Version files, nearest directory first; within a directory, in this order. */
const VERSION_FILES = [".node-version", ".nvmrc", ".tool-versions"] as const;

/** nvm's LTS codenames. */
const LTS_CODENAMES: Record<string, number> = {
  argon: 4,
  boron: 6,
  carbon: 8,
  dubnium: 10,
  erbium: 12,
  fermium: 14,
  gallium: 16,
  hydrogen: 18,
  iron: 20,
  jod: 22,
  krypton: 24,
};

export interface NodeVersionChoice {
  major: number;
  /** Why this major, for the build log. */
  reason: string;
}

/**
 * The Node version a repository asks for: a version file (.node-version,
 * .nvmrc or asdf's .tool-versions, in the package's directory or above it)
 * or package.json engines.node. The image is the requested major when
 * Shipyard has one; otherwise the nearest supported major, with a note
 * saying so. A version file that contradicts engines.node loses to engines,
 * which the install itself may enforce.
 */
export async function selectNodeVersion(
  /** Directories to look in for version files, nearest first (the package's, then its parents up to the repository root). */
  dirs: readonly { dir: string; rel: string }[],
  engines: string | undefined,
  notes: string[],
): Promise<NodeVersionChoice> {
  const file = await readVersionFile(dirs, notes);
  const range = engines?.trim() ? engines.trim() : null;
  const validRange = range !== null && semver.validRange(range) !== null ? range : null;
  if (range !== null && validRange === null) notes.push(`engines.node "${truncate(range)}" is not a valid semver range; it is ignored.`);
  const allowed = (major: number) => validRange === null || semver.intersects(validRange, `^${major}.0.0`);

  if (file) {
    if (!allowed(file.major)) {
      const major = newestAllowed(allowed, range!);
      notes.push(`${file.source} asks for Node ${file.major}, but engines.node is "${truncate(range!)}"; using Node ${major}, which engines allows.`);
      return { major, reason: `engines.node "${truncate(range!, 40)}" → Node ${major} (${file.source} conflicts with it)` };
    }
    if ((SUPPORTED_NODE_MAJORS as readonly number[]).includes(file.major)) {
      return { major: file.major, reason: `${file.source} → Node ${file.major}` };
    }
    const nearest = nearestSupported(file.major, allowed);
    notes.push(
      `${file.source} asks for Node ${file.major}, which generated Dockerfiles don't provide (they support ${SUPPORTED_NODE_MAJORS.join(", ")}); using Node ${nearest}. ` +
        "Commit a Dockerfile to use exactly that version.",
    );
    return { major: nearest, reason: `${file.source} asks for Node ${file.major} → nearest supported: Node ${nearest}` };
  }

  if (validRange !== null) {
    const major = newestAllowed(allowed, range!);
    if (major === 20) notes.push("Node 20 is end-of-life; consider upgrading to Node 22 or 24.");
    return { major, reason: `engines.node "${truncate(range!, 40)}" → Node ${major}` };
  }
  return { major: DEFAULT_NODE_MAJOR, reason: `no .nvmrc, .node-version or engines.node → Node ${DEFAULT_NODE_MAJOR} (current LTS)` };
}

/** The newest supported major engines allows; one it rules out entirely is an error, not a silent fallback. */
function newestAllowed(allowed: (major: number) => boolean, range: string): number {
  const major = SUPPORTED_NODE_MAJORS.find(allowed);
  if (major === undefined) {
    throw detectionError(
      `package.json requires Node "${truncate(range)}", but generated Dockerfiles support Node ` +
        `${SUPPORTED_NODE_MAJORS.join(", ")}. Widen engines.node, or add a Dockerfile to use a different version.`,
    );
  }
  return major;
}

/** The oldest supported major at or above `requested` (an EOL 18 → 20), else the newest. */
function nearestSupported(requested: number, allowed: (major: number) => boolean): number {
  const ascending = [...SUPPORTED_NODE_MAJORS].reverse().filter(allowed);
  return ascending.find((major) => major >= requested) ?? ascending.at(-1) ?? DEFAULT_NODE_MAJOR;
}

async function readVersionFile(dirs: readonly { dir: string; rel: string }[], notes: string[]): Promise<{ major: number; source: string } | null> {
  for (const { dir, rel } of dirs) {
    for (const name of VERSION_FILES) {
      const text = await readRegularFile(dir, name, 4096).catch(() => null);
      if (text === null) continue;
      const source = rel === "." ? name : `${rel}/${name}`;
      const value = name === ".tool-versions" ? /^nodejs\s+(\S+)/m.exec(text)?.[1] : text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
      if (value === undefined) continue; // .tool-versions without nodejs
      const major = parseNodeVersion(value);
      if (major === null) {
        notes.push(`${source} has "${truncate(value, 40)}", which isn't a Node version Shipyard understands; it is ignored.`);
        continue;
      }
      return { major, source };
    }
  }
  return null;
}

/** "20", "v20.11.1", "20.x", "lts/iron", "lts/*", "node" → a major; null when unreadable. */
export function parseNodeVersion(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (text === "node" || text === "stable" || text === "latest" || text === "current" || text === "lts/*" || text === "lts") return DEFAULT_NODE_MAJOR;
  const lts = /^lts\/([a-z]+)$/.exec(text);
  if (lts) return LTS_CODENAMES[lts[1]!] ?? null;
  const match = /^v?(\d{1,3})(?:\.(?:\d+|x|\*)){0,2}$/.exec(text);
  return match ? Number(match[1]) : null;
}
