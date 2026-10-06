import { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { isRegularFile, readRegularFile } from "./files.js";
import { selectNodeVersion } from "./nodeVersion.js";
import { detectPackageManager } from "./packageManager.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export { DEFAULT_NODE_MAJOR, SUPPORTED_NODE_MAJORS } from "./nodeVersion.js";
export { detectPackageManager } from "./packageManager.js";

/** Entry files tried, in order, when there is neither a start script nor `main`. */
const FALLBACK_ENTRY_FILES = ["server.js", "index.js", "app.js"];

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/**
 * A relative path to a JS file, safe to place in a Dockerfile CMD: no `..`,
 * no absolute paths, no whitespace or shell metacharacters.
 */
const SAFE_ENTRY_PATH = /^(?:\.\/)?[A-Za-z0-9_@][A-Za-z0-9_@.\/-]{0,199}$/;

const packageJsonSchema = z.looseObject({
  name: z.string().optional(),
  main: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional().catch(undefined),
  devDependencies: z.record(z.string(), z.string()).optional().catch(undefined),
  scripts: z.record(z.string(), z.string()).optional(),
  engines: z.looseObject({ node: z.string().optional() }).optional().catch(undefined),
  packageManager: z.string().optional(),
  workspaces: z.unknown().optional(),
});

/** npm/pnpm/yarn run these during install: they may need the whole source. */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];
/** Package-manager config the install reads, copied with the manifests when present. */
const INSTALL_CONFIG_FILES = [".npmrc", ".yarnrc", ".pnpmfile.cjs"];

export type PackageJson = z.infer<typeof packageJsonSchema>;

export interface NodeProject {
  packageManager: PackageManager;
  /** Major version of the package manager: pinned in package.json, or inferred from the lockfile. */
  packageManagerMajor: number | null;
  /**
   * Version installed in the image: exact ("9.15.0") when package.json pins
   * one, else a major chosen for the lockfile ("9"). null = the image's own (npm).
   */
  packageManagerVersion: string | null;
  /** Why this package manager and version (for the build log). */
  packageManagerReason: string;
  /** What makes the lockfile unusable for a frozen install, if anything: the build is expected to fail on it. */
  staleLockfile: string[] | null;
  /** Lockfile matching the package manager, or null (non-reproducible install). */
  lockfile: string | null;
  nodeMajor: number;
  hasBuildScript: boolean;
  /** Exec-form command (no shell) that starts the app. */
  startCommand: string[];
  /**
   * Files the install needs, in order: copied before the rest of the source so
   * the install layer is reused from Docker's cache until one of them changes.
   * null = the install may need the whole source (install hooks, workspaces,
   * Yarn 2+), so nothing is cached separately — correctness over speed.
   */
  dependencyFiles: string[] | null;
  /** Human-readable decisions worth showing in the build log. */
  notes: string[];
}

/**
 * Reads a cloned repository and decides how to build and start it as a Node.js
 * app. Returns null when there is no package.json (not a Node project).
 * Throws PROJECT_DETECTION_FAILED when it IS a Node project but Shipyard can't
 * work out a correct build — guessing wrong would produce a broken image.
 */
export async function detectNodeProject(
  sourceDir: string,
  options: {
    /** A start command configured for the service: detection doesn't need to find one. */
    startCommand?: string | null;
  } = {},
): Promise<NodeProject | null> {
  const raw = await readRegularFile(sourceDir, "package.json", MAX_PACKAGE_JSON_BYTES);
  if (raw === null) return null;

  const pkg = parsePackageJson(raw);
  const notes: string[] = [];

  const choice = await detectPackageManager(sourceDir, pkg, notes);
  const { manager, major, lockfile } = choice;
  const { major: nodeMajor } = await selectNodeVersion([{ dir: sourceDir, rel: "." }], pkg.engines?.node, notes);
  const startCommand = options.startCommand
    ? ["sh", "-c", options.startCommand]
    : await resolveStartCommand(sourceDir, pkg, manager);
  const dependencyFiles = await selectDependencyFiles(sourceDir, pkg, manager, major, lockfile, notes);

  return {
    packageManager: manager,
    packageManagerMajor: major,
    packageManagerVersion: choice.version,
    packageManagerReason: choice.reason,
    staleLockfile: choice.staleLockfile,
    lockfile,
    nodeMajor,
    hasBuildScript: Boolean(pkg.scripts?.build?.trim()),
    startCommand,
    dependencyFiles,
    notes,
  };
}

export async function selectDependencyFiles(
  sourceDir: string,
  pkg: PackageJson,
  manager: PackageManager,
  major: number | null,
  lockfile: string | null,
  notes: string[],
): Promise<string[] | null> {
  const hooks = INSTALL_HOOKS.filter((hook) => pkg.scripts?.[hook]?.trim());
  const uncachable =
    hooks.length > 0
      ? `install scripts (${hooks.join(", ")}) may need the source`
      : pkg.workspaces !== undefined || (await isRegularFile(sourceDir, "pnpm-workspace.yaml"))
        ? "workspaces need every package's source"
        : hasPatchedDependencies(pkg)
          ? "patched dependencies need their patch files"
        : manager === "yarn" && major !== null && major >= 2
          ? "Yarn 2+ installs need the .yarn directory"
          : null;
  if (uncachable) {
    notes.push(`Dependencies are installed with the whole source (${uncachable}), so the install isn't cached separately.`);
    return null;
  }
  const config = [];
  for (const file of INSTALL_CONFIG_FILES) if (await isRegularFile(sourceDir, file)) config.push(file);
  return ["package.json", ...(lockfile ? [lockfile] : []), ...config];
}

function hasPatchedDependencies(pkg: PackageJson): boolean {
  const pnpm = (pkg as { pnpm?: { patchedDependencies?: unknown } }).pnpm;
  if (pnpm && typeof pnpm === "object" && pnpm.patchedDependencies) return true;
  const specs = Object.values({ ...pkg.dependencies, ...pkg.devDependencies });
  return specs.some((spec) => spec.startsWith("patch:"));
}

export function parsePackageJson(raw: string): PackageJson {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw detectionError("package.json is not valid JSON.");
  }

  const result = packageJsonSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? ` at "${issue.path.join(".")}"` : "";
    throw detectionError(`package.json is invalid${where}: ${issue?.message ?? "unexpected shape"}.`);
  }
  return result.data;
}

/**
 * How the app starts: `preferredScript` (e.g. NestJS's start:prod) or the
 * start script, then a framework's own server (`frameworkStart`), then
 * `main`, then a conventional entry file.
 */
export async function resolveStartCommand(
  sourceDir: string,
  pkg: PackageJson,
  manager: PackageManager,
  frameworkStart: string[] | null = null,
  preferredScript: string | null = null,
): Promise<string[]> {
  if (preferredScript && pkg.scripts?.[preferredScript]?.trim()) return [manager, "run", preferredScript];
  if (pkg.scripts?.start?.trim()) return [manager, "start"];
  if (frameworkStart) return frameworkStart;

  if (pkg.main !== undefined) {
    if (!isSafeEntryPath(pkg.main)) {
      throw detectionError(`package.json "main" is not a safe relative path: "${truncate(pkg.main)}".`);
    }
    return ["node", pkg.main];
  }

  for (const file of FALLBACK_ENTRY_FILES) {
    if (await isRegularFile(sourceDir, file)) return ["node", file];
  }

  throw detectionError(
    'Could not tell how to start this app. Add a "start" script to package.json ' +
      '(e.g. "start": "node server.js"), or add a Dockerfile.',
  );
}

export function isSafeEntryPath(value: string): boolean {
  return SAFE_ENTRY_PATH.test(value) && !value.split("/").includes("..");
}

export function detectionError(message: string): AppError {
  return new AppError(ErrorCode.PROJECT_DETECTION_FAILED, message, { statusCode: 422 });
}

/** Repository content ends up in logs and API errors; keep echoed values short. */
export function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
