import fs from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { detectRepository } from "../detection/RepositoryDetector.js";
import type { BuildOverrides, DetectionResult } from "../detection/types.js";

export type { BuildOverrides } from "../detection/types.js";

/**
 * A generated Dockerfile gets its own name so it can never be confused with,
 * or overwrite, anything the repository contains.
 */
export const GENERATED_DOCKERFILE_NAME = ".shipyard.Dockerfile";

export interface BuildPlan {
  /** Dockerfile path relative to the build context. */
  dockerfile: string;
  containerPort: number;
  source: "repository" | "generated";
  /** Start command to run instead of the image's (a configured one, with the repository's Dockerfile). */
  command?: string[];
  /** The build context (absolute): the service's directory, or a workspace/repository root above it. */
  contextDir: string;
  /** What was detected, as written to the build log. */
  detection: DetectionResult;
}

/**
 * Decides how to build a service from a cloned repository (see
 * RepositoryDetector): the repository's own Dockerfile when it has one (the
 * user is in control), else a Dockerfile generated for the detected
 * language and framework, else an error saying what was found and what to do.
 *
 * `sourceDir` is the service's directory inside the clone at
 * `options.repositoryDir` (default: the same directory). Generated files are
 * written into the clone only, which must be disposable: never into the
 * user's repository.
 */
export async function prepareBuild(
  sourceDir: string,
  log: (text: string) => void,
  /** Build variable names, declared as ARGs in a generated Dockerfile. */
  buildArgNames: readonly string[] = [],
  overrides: BuildOverrides = {},
  options: { repositoryDir?: string } = {},
): Promise<BuildPlan> {
  const repositoryDir = await fs.realpath(options.repositoryDir ?? sourceDir);
  const { candidate, serviceDirectory } = await detectRepository({ root: repositoryDir, serviceDir: sourceDir, overrides });
  const contextDir = candidate.contextDirectory === "." ? repositoryDir : path.join(repositoryDir, candidate.contextDirectory);
  const port = overrides.port ?? candidate.port;
  const portSource = overrides.port ? "configured for the service" : candidate.portSource;
  const detection = (dockerfilePath: string, source: "repository" | "generated"): DetectionResult => ({
    projectType: candidate.projectType,
    language: candidate.language,
    framework: candidate.framework,
    runtime: candidate.runtime,
    packageManager: candidate.packageManager,
    serviceDirectory,
    contextDirectory: candidate.contextDirectory,
    dockerfilePath,
    dockerfile: source,
    entrypoint: candidate.entrypoint,
    buildCommand: source === "repository" ? null : (overrides.buildCommand ?? candidate.buildCommand),
    startCommand: overrides.startCommand ?? candidate.startCommand,
    port,
    portSource,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    notes: candidate.notes,
  });

  if (candidate.dockerfile.kind === "repository") {
    const exposed = candidate.dockerfile.exposedPort;
    log(
      overrides.port
        ? `Using the configured port ${port}\n`
        : exposed === null
          ? `Dockerfile has no EXPOSE; assuming port ${port}\n`
          : `Dockerfile exposes port ${port}\n`,
    );
    if (overrides.buildCommand) log("note: the build command is ignored: the repository's Dockerfile decides the build.\n");
    const result = detection(candidate.dockerfile.path, "repository");
    log(describeDetection(result));
    return {
      dockerfile: candidate.dockerfile.path,
      containerPort: port,
      source: "repository",
      ...(overrides.startCommand && { command: ["sh", "-c", overrides.startCommand] }),
      contextDir,
      detection: result,
    };
  }

  if (candidate.language === "Node.js") {
    log(`No Dockerfile found; detected a Node.js project (${candidate.packageManager}, ${candidate.runtime})\n`);
    for (const note of candidate.notes) log(`  note: ${note}\n`);
  } else {
    log(`No Dockerfile found; detected a ${candidate.framework ? `${candidate.framework} (${candidate.language})` : candidate.language} project\n`);
    for (const note of candidate.notes) log(`  note: ${note}\n`);
  }
  const contents = candidate.dockerfile.render({
    port,
    buildArgNames,
    buildCommand: overrides.buildCommand ?? null,
    startCommand: overrides.startCommand ?? null,
  });
  await writeNewFile(contextDir, GENERATED_DOCKERFILE_NAME, contents);
  if (await writeNewFile(contextDir, ".dockerignore", candidate.dockerfile.dockerignore, { ifExists: "skip" })) {
    log(`Added a default .dockerignore (${candidate.dockerfile.dockerignore.split("\n").filter((line) => line && !line.startsWith("#")).join(", ")})\n`);
  }
  const result = detection(GENERATED_DOCKERFILE_NAME, "generated");
  log(describeDetection(result));
  log(`Generated Dockerfile:\n${contents.replace(/^/gm, "  ")}`);

  return { dockerfile: GENERATED_DOCKERFILE_NAME, containerPort: port, source: "generated", contextDir, detection: result };
}

/** The detection summary for the build log. */
export function describeDetection(result: DetectionResult): string {
  const rows: Array<[string, string | null]> = [
    ["Language", result.language],
    ["Framework", result.framework],
    ["Runtime", result.runtime],
    ["Package manager", result.packageManager],
    ["Service", result.serviceDirectory === "." ? ". (repository root)" : result.serviceDirectory],
    ["Build context", result.contextDirectory !== result.serviceDirectory ? result.contextDirectory : null],
    ["Build", result.buildCommand],
    ["Start", result.startCommand],
    ["Port", `${result.port} (${result.portSource})`],
    ["Dockerfile", result.dockerfile === "generated" ? "generated" : `${result.dockerfilePath} (from the repository)`],
    ["Confidence", `${Math.round(result.confidence * 100)}%`],
  ];
  const lines = ["Detected:", ...rows.filter(([, value]) => value).map(([label, value]) => `  ${`${label}:`.padEnd(17)}${value}`)];
  if (result.reasons.length > 0) lines.push("  Why:", ...result.reasons.map((reason) => `    - ${reason}`));
  return `${lines.join("\n")}\n`;
}

/**
 * Creates `<dir>/<name>` with O_EXCL ("wx"): it fails if ANYTHING exists at that
 * path — including a symlink — so a malicious repository cannot redirect the
 * write outside the clone. Returns false when skipped.
 */
async function writeNewFile(
  dir: string,
  name: string,
  contents: string,
  options: { ifExists: "fail" | "skip" } = { ifExists: "fail" },
): Promise<boolean> {
  try {
    await fs.writeFile(path.join(dir, name), contents, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (options.ifExists === "skip") return false;
    throw new AppError(
      ErrorCode.PROJECT_DETECTION_FAILED,
      `The repository contains ${name}, a name Shipyard reserves for generated files. Rename it or add a Dockerfile.`,
      { statusCode: 422 },
    );
  }
}
