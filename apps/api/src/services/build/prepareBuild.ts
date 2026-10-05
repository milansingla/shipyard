import fs from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { DEFAULT_CONTAINER_PORT, DOCKERFILE_NAME, detectDockerfile } from "../detection/dockerfile.js";
import { GENERATED_DOCKERIGNORE, generateNodeDockerfile } from "../detection/generateDockerfile.js";
import { detectNodeProject } from "../detection/nodeProject.js";

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
}

/** What a service configures instead of detecting it (shipyard.yaml or the dashboard). */
export interface BuildOverrides {
  buildCommand?: string | null;
  startCommand?: string | null;
  port?: number | null;
}

/**
 * Decides how to build a cloned repository:
 *   1. its own Dockerfile, if it has one (the user is in control), else
 *   2. a Dockerfile generated from package.json, else
 *   3. DOCKERFILE_NOT_FOUND.
 * May write the generated files into `sourceDir`, which must be a disposable clone.
 */
export async function prepareBuild(
  sourceDir: string,
  log: (text: string) => void,
  /** Build variable names, declared as ARGs in a generated Dockerfile. */
  buildArgNames: readonly string[] = [],
  overrides: BuildOverrides = {},
): Promise<BuildPlan> {
  const dockerfile = await detectDockerfile(sourceDir);
  if (dockerfile) {
    const containerPort = overrides.port ?? dockerfile.exposedPort ?? DEFAULT_CONTAINER_PORT;
    log(
      overrides.port
        ? `Using the configured port ${containerPort}\n`
        : dockerfile.exposedPort === null
          ? `Dockerfile has no EXPOSE; assuming port ${containerPort}\n`
          : `Dockerfile exposes port ${containerPort}\n`,
    );
    if (overrides.buildCommand) log("note: the build command is ignored: the repository's Dockerfile decides the build.\n");
    return {
      dockerfile: DOCKERFILE_NAME,
      containerPort,
      source: "repository",
      ...(overrides.startCommand && { command: ["sh", "-c", overrides.startCommand] }),
    };
  }

  const node = await detectNodeProject(sourceDir, { startCommand: overrides.startCommand });
  if (!node) {
    throw new AppError(
      ErrorCode.DOCKERFILE_NOT_FOUND,
      "No Dockerfile or package.json found in the service's directory. Shipyard can generate a Dockerfile " +
        "for Node.js projects; for anything else, add a Dockerfile.",
      { statusCode: 422 },
    );
  }

  log(`No Dockerfile found; detected a Node.js project (${node.packageManager}, Node ${node.nodeMajor})\n`);
  for (const note of node.notes) log(`  note: ${note}\n`);

  const port = overrides.port ?? DEFAULT_CONTAINER_PORT;
  const contents = generateNodeDockerfile(node, port, buildArgNames, overrides.buildCommand ?? null);
  await writeNewFile(sourceDir, GENERATED_DOCKERFILE_NAME, contents);
  if (await writeNewFile(sourceDir, ".dockerignore", GENERATED_DOCKERIGNORE, { ifExists: "skip" })) {
    log("Added a default .dockerignore (node_modules, .git)\n");
  }
  log(`Generated Dockerfile:\n${contents.replace(/^/gm, "  ")}`);

  return { dockerfile: GENERATED_DOCKERFILE_NAME, containerPort: port, source: "generated" };
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
