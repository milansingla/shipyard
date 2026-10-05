import semver from "semver";
import { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { isRegularFile, readRegularFile } from "./files.js";

export type PackageManager = "npm" | "pnpm" | "yarn";

/** Node majors with official `node:<major>-slim` images, newest first. */
export const SUPPORTED_NODE_MAJORS = [24, 22, 20] as const;
export const DEFAULT_NODE_MAJOR = 24;

/** Checked in this order when package.json has no `packageManager` field. */
const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
];

/** Entry files tried, in order, when there is neither a start script nor `main`. */
const FALLBACK_ENTRY_FILES = ["server.js", "index.js", "app.js"];

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/**
 * A relative path to a JS file, safe to place in a Dockerfile CMD: no `..`,
 * no absolute paths, no whitespace or shell metacharacters.
 */
const SAFE_ENTRY_PATH = /^(?:\.\/)?[A-Za-z0-9_@][A-Za-z0-9_@.\/-]{0,199}$/;

const packageJsonSchema = z.looseObject({
  main: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  engines: z.looseObject({ node: z.string().optional() }).optional(),
  packageManager: z.string().optional(),
  workspaces: z.unknown().optional(),
});

/** npm/pnpm/yarn run these during install: they may need the whole source. */
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];
/** Package-manager config the install reads, copied with the manifests when present. */
const INSTALL_CONFIG_FILES = [".npmrc", ".yarnrc"];

type PackageJson = z.infer<typeof packageJsonSchema>;

export interface NodeProject {
  packageManager: PackageManager;
  /** Major version from package.json `packageManager` (corepack), if declared. */
  packageManagerMajor: number | null;
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
export async function detectNodeProject(sourceDir: string): Promise<NodeProject | null> {
  const raw = await readRegularFile(sourceDir, "package.json", MAX_PACKAGE_JSON_BYTES);
  if (raw === null) return null;

  const pkg = parsePackageJson(raw);
  const notes: string[] = [];

  const { manager, major, lockfile } = await detectPackageManager(sourceDir, pkg.packageManager, notes);
  const nodeMajor = selectNodeMajor(pkg.engines?.node, notes);
  const startCommand = await resolveStartCommand(sourceDir, pkg, manager);
  const dependencyFiles = await selectDependencyFiles(sourceDir, pkg, manager, major, lockfile, notes);

  return {
    packageManager: manager,
    packageManagerMajor: major,
    lockfile,
    nodeMajor,
    hasBuildScript: Boolean(pkg.scripts?.build?.trim()),
    startCommand,
    dependencyFiles,
    notes,
  };
}

async function selectDependencyFiles(
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
 * Picks the newest supported Node major that satisfies `engines.node`.
 * No constraint → the default. An unsatisfiable constraint is an error rather
 * than a silent fallback: building on the wrong Node version fails in confusing ways.
 */
export function selectNodeMajor(range: string | undefined, notes: string[] = []): number {
  if (!range?.trim()) return DEFAULT_NODE_MAJOR;

  if (semver.validRange(range) === null) {
    notes.push(`engines.node "${truncate(range)}" is not a valid semver range; using Node ${DEFAULT_NODE_MAJOR}.`);
    return DEFAULT_NODE_MAJOR;
  }

  const major = SUPPORTED_NODE_MAJORS.find((candidate) => semver.intersects(range, `^${candidate}.0.0`));
  if (major === undefined) {
    throw detectionError(
      `package.json requires Node "${truncate(range)}", but generated Dockerfiles support Node ` +
        `${SUPPORTED_NODE_MAJORS.join(", ")}. Add a Dockerfile to use a different version.`,
    );
  }
  if (major === 20) notes.push("Node 20 is end-of-life; consider upgrading to Node 22 or 24.");
  return major;
}

async function detectPackageManager(
  sourceDir: string,
  field: string | undefined,
  notes: string[],
): Promise<{ manager: PackageManager; major: number | null; lockfile: string | null }> {
  const present: Array<(typeof LOCKFILES)[number]> = [];
  for (const entry of LOCKFILES) {
    if (await isRegularFile(sourceDir, entry.file)) present.push(entry);
  }

  if (field !== undefined) {
    // Corepack format: name@exact.version, optionally +sha… — e.g. "pnpm@9.12.0".
    const match = /^(npm|pnpm|yarn)@(\d+)\.\d+\.\d+(?:[-+][\w.+-]*)?$/.exec(field.trim());
    if (!match?.[1] || !match[2]) {
      throw detectionError(
        `Unsupported "packageManager" in package.json: "${truncate(field)}". ` +
          `Shipyard supports npm, pnpm and yarn (e.g. "pnpm@9.12.0").`,
      );
    }
    const manager = match[1] as PackageManager;
    const lockfile = present.find((entry) => entry.manager === manager)?.file ?? null;
    if (lockfile === null) notes.push(`No ${manager} lockfile found; dependency versions are not pinned.`);
    return { manager, major: Number(match[2]), lockfile };
  }

  const chosen = present[0];
  if (!chosen) {
    notes.push("No lockfile found; installing with npm. Commit a lockfile for reproducible builds.");
    return { manager: "npm", major: null, lockfile: null };
  }
  const managers = new Set(present.map((entry) => entry.manager));
  if (managers.size > 1) {
    notes.push(`Found lockfiles for ${[...managers].join(", ")}; using ${chosen.manager} (${chosen.file}).`);
  }
  return { manager: chosen.manager, major: null, lockfile: chosen.file };
}

async function resolveStartCommand(sourceDir: string, pkg: PackageJson, manager: PackageManager): Promise<string[]> {
  if (pkg.scripts?.start?.trim()) return [manager, "start"];

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

function detectionError(message: string): AppError {
  return new AppError(ErrorCode.PROJECT_DETECTION_FAILED, message, { statusCode: 422 });
}

/** Repository content ends up in logs and API errors; keep echoed values short. */
function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
