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
}

/**
 * Decides how to build a cloned repository:
 *   1. its own Dockerfile, if it has one (the user is in control), else
 *   2. a Dockerfile generated from package.json, else
 *   3. DOCKERFILE_NOT_FOUND.
 * May write the generated files into `sourceDir`, which must be a disposable clone.
 */
export async function prepareBuild(sourceDir: string, log: (text: string) => void): Promise<BuildPlan> {
  const dockerfile = await detectDockerfile(sourceDir);
  if (dockerfile) {
    const containerPort = dockerfile.exposedPort ?? DEFAULT_CONTAINER_PORT;
    log(
      dockerfile.exposedPort === null
        ? `Dockerfile has no EXPOSE; assuming port ${containerPort}\n`
        : `Dockerfile exposes port ${containerPort}\n`,
    );
    return { dockerfile: DOCKERFILE_NAME, containerPort, source: "repository" };
  }

  const node = await detectNodeProject(sourceDir);
  if (!node) {
    throw new AppError(
      ErrorCode.DOCKERFILE_NOT_FOUND,
      "No Dockerfile or package.json found at the repository root. Shipyard can generate a Dockerfile " +
        "for Node.js projects; for anything else, add a Dockerfile.",
      { statusCode: 422 },
    );
  }

  log(`No Dockerfile found; detected a Node.js project (${node.packageManager}, Node ${node.nodeMajor})\n`);
  for (const note of node.notes) log(`  note: ${note}\n`);

  const contents = generateNodeDockerfile(node, DEFAULT_CONTAINER_PORT);
  await writeNewFile(sourceDir, GENERATED_DOCKERFILE_NAME, contents);
  if (await writeNewFile(sourceDir, ".dockerignore", GENERATED_DOCKERIGNORE, { ifExists: "skip" })) {
    log("Added a default .dockerignore (node_modules, .git)\n");
  }
  log(`Generated Dockerfile:\n${contents.replace(/^/gm, "  ")}`);

  return { dockerfile: GENERATED_DOCKERFILE_NAME, containerPort: DEFAULT_CONTAINER_PORT, source: "generated" };
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
