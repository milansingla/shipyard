import fs from "node:fs/promises";

import { detectDockerfile } from "../../services/detection/dockerfile.js";
import { readRegularFile } from "../../services/detection/files.js";
import { detectNodeProject } from "../../services/detection/nodeProject.js";

/** Files worth showing the model, when the repository has them. Nothing else is read. */
export const EVIDENCE_FILES = [
  "package.json",
  "Dockerfile",
  "shipyard.yaml",
  "shipyard.yml",
  ".nvmrc",
  ".node-version",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "nest-cli.json",
  "Procfile",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
] as const;
const MAX_FILE_BYTES = 16 * 1024;

export interface RepositoryEvidence {
  /** Top-level names in the repository (not their contents). */
  listing: string[];
  /** File name → contents, for the files above that exist (regular files only, no symlinks). */
  files: Record<string, string>;
  /** What Shipyard itself detects: the facts that decide the build. */
  detected: {
    dockerfile: { exposedPort: number | null } | null;
    node: {
      packageManager: string;
      nodeMajor: number;
      startCommand: string;
      hasBuildScript: boolean;
    } | null;
    nodeError: string | null;
  };
}

export async function gatherRepositoryEvidence(dir: string): Promise<RepositoryEvidence> {
  const listing = (await fs.readdir(dir))
    .filter((name) => name !== ".git")
    .sort()
    .slice(0, 200);
  const files: Record<string, string> = {};
  for (const name of EVIDENCE_FILES) {
    const contents = await readRegularFile(dir, name, MAX_FILE_BYTES).catch(() => null);
    if (contents !== null) files[name] = contents;
  }
  const dockerfile = await detectDockerfile(dir).catch(() => null);
  let node: RepositoryEvidence["detected"]["node"] = null;
  let nodeError: string | null = null;
  try {
    const detected = await detectNodeProject(dir, {});
    if (detected) {
      node = {
        packageManager: detected.packageManager,
        nodeMajor: detected.nodeMajor,
        startCommand: detected.startCommand.join(" "),
        hasBuildScript: detected.hasBuildScript,
      };
    }
  } catch (error) {
    nodeError = (error as Error).message;
  }
  return {
    listing,
    files,
    detected: {
      dockerfile: dockerfile && { exposedPort: dockerfile.exposedPort },
      node,
      nodeError,
    },
  };
}

/**
 * Keeps only evidence the source really contains: a quote must appear
 * (whitespace-insensitively) in the text it claims to come from. The rest is
 * dropped and counted, so an invented "fact" never reaches the user as evidence.
 */
export function verifyQuotes<T extends { excerpt: string }>(
  claims: readonly T[],
  source: (claim: T) => string | undefined,
): { verified: T[]; dropped: number } {
  const verified: T[] = [];
  for (const claim of claims) {
    const text = source(claim);
    const excerpt = squash(claim.excerpt);
    if (text !== undefined && excerpt.length >= 3 && squash(text).includes(excerpt)) verified.push(claim);
  }
  return { verified, dropped: claims.length - verified.length };
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Static checks on a suggested Dockerfile before anyone uses it. Problems
 * make it unusable as is; warnings are worth fixing. Shipyard never deploys
 * a suggestion itself: it is committed (or not) by a person.
 */
export function checkDockerfile(text: string): {
  problems: string[];
  warnings: string[];
} {
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!/^FROM\s+\S+/i.test(lines.find((line) => !/^ARG\s/i.test(line)) ?? "")) problems.push("It must start with FROM (after any ARG).");
  if (/--privileged|--security-opt|--cap-add/i.test(text)) problems.push("It asks for extra privileges.");
  if (/^ADD\s+https?:\/\//im.test(text))
    problems.push("ADD from a URL downloads unverified code at build time; use COPY, or curl with a checksum.");
  if (/(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b/i.test(text)) problems.push("It pipes a download into a shell.");
  if (/^(ENV|ARG)\s+\S*(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\S*\s*[= ]\s*\S+/im.test(text)) {
    problems.push("It writes a secret into the image (anyone with the image can read it); use Shipyard's secrets instead.");
  }
  const users = lines.filter((line) => /^USER\s/i.test(line));
  if (users.length === 0 || /^USER\s+(root|0)(\s|$)/i.test(users.at(-1)!)) warnings.push("It runs as root; add a USER (e.g. USER node).");
  if (!lines.some((line) => /^EXPOSE\s/i.test(line))) warnings.push("No EXPOSE: Shipyard will assume port 3000.");
  if (/^FROM\s+[^\s:]+(:latest)?(\s|$)/im.test(text) && !/^FROM\s+\S+:\S+/im.test(text.replace(/:latest/gi, ""))) {
    warnings.push("The base image isn't pinned to a version (latest changes under you).");
  }
  return { problems, warnings };
}
