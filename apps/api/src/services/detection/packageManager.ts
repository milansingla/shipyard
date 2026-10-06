import semver from "semver";

import { checkLockfile } from "./lockfileSync.js";
import { isRegularFile } from "./files.js";
import { detectionError, truncate, type PackageJson, type PackageManager } from "./nodeProject.js";

/** Checked in this order when package.json has no `packageManager` field. */
export const LOCKFILES: ReadonlyArray<{ file: string; manager: PackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
];

/**
 * pnpm lockfile formats and the pnpm majors that read them, oldest first.
 * The oldest is the default: it is the closest match to whatever wrote the
 * lockfile, and pnpm 10+ no longer runs dependencies' install scripts unless
 * the project allows them, which breaks apps that never needed to.
 */
const PNPM_LOCKFILE_MAJORS: Record<string, readonly number[]> = {
  "5.3": [6],
  "5.4": [7],
  "6.0": [8],
  "6.1": [8],
  "9.0": [9, 10, 11, 12],
};
/** pnpm without a lockfile or a pinned version. */
const DEFAULT_PNPM_MAJOR = 9;

/** Yarn Berry's lockfile __metadata version → the Yarn major that writes it. */
function yarnMajorForMetadata(version: number): number {
  return version >= 8 ? 4 : version >= 6 ? 3 : 2;
}

/** Corepack's format: name@exact.version, optionally +sha… — e.g. "pnpm@9.12.0". */
const PACKAGE_MANAGER_FIELD = /^(npm|pnpm|yarn|bun)@(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.+-]*)?$/;

export interface PackageManagerChoice {
  manager: PackageManager;
  major: number | null;
  /**
   * The version to install: exact ("9.15.0") when pinned, else a major ("9")
   * chosen to read the lockfile. null = the one in the image (npm).
   */
  version: string | null;
  /** Why this manager and version, for the build log. */
  reason: string;
  /** Lockfile matching the package manager, or null (non-reproducible install). */
  lockfile: string | null;
  /** What makes the lockfile unusable for a frozen install, when something does. */
  staleLockfile: string[] | null;
}

/**
 * Picks the package manager and its version from the repository itself:
 * package.json "packageManager", else the lockfile (pnpm, yarn, npm, bun, in
 * that order). With several lockfiles, one that no longer matches
 * package.json loses to one that does. The version comes from the field, or
 * from the lockfile's format, never just "latest".
 */
export async function detectPackageManager(dir: string, pkg: PackageJson | null, notes: string[]): Promise<PackageManagerChoice> {
  const present: Array<(typeof LOCKFILES)[number]> = [];
  for (const entry of LOCKFILES) {
    if (await isRegularFile(dir, entry.file)) present.push(entry);
  }
  const manifest = pkg ?? ({} as PackageJson);
  const field = pkg?.packageManager;

  if (field !== undefined) {
    const match = PACKAGE_MANAGER_FIELD.exec(field.trim());
    if (!match?.[1]) {
      throw detectionError(
        `Unsupported "packageManager" in package.json: "${truncate(field)}". ` +
          `Shipyard supports npm, pnpm, yarn and bun with an exact version (e.g. "pnpm@9.15.0").`,
      );
    }
    const manager = match[1] as PackageManager;
    const major = Number(match[2]);
    const version = `${match[2]}.${match[3]}.${match[4]}${match[5] ?? ""}`;
    const lockfile = present.find((entry) => entry.manager === manager)?.file ?? null;
    const others = [...new Set(present.filter((entry) => entry.manager !== manager).map((entry) => entry.file))];
    if (others.length > 0) notes.push(`package.json pins ${manager}, so ${others.join(" and ")} ${others.length === 1 ? "is" : "are"} ignored.`);
    let staleLockfile: string[] | null = null;
    if (lockfile === null) {
      notes.push(`No ${manager} lockfile found; dependency versions are not pinned. Commit one for reproducible builds.`);
    } else {
      const sync = await checkLockfile(dir, lockfile, manager, manifest);
      staleLockfile = sync.problems;
      if (manager === "pnpm" && sync.format) {
        const readers = PNPM_LOCKFILE_MAJORS[sync.format];
        if (readers && !readers.includes(major)) {
          notes.push(`packageManager pins pnpm ${version}, but ${lockfile} (lockfileVersion ${sync.format}) was written by pnpm ${readers.join("/")}; the install may reject it.`);
        }
      }
    }
    return { manager, major, version, reason: `packageManager "${truncate(field, 40)}" in package.json → ${manager} ${version}`, lockfile, staleLockfile };
  }

  if (present.length === 0) {
    notes.push("No lockfile found; installing with npm. Commit a lockfile for reproducible builds.");
    return { manager: "npm", major: null, version: null, reason: "no lockfile → npm", lockfile: null, staleLockfile: null };
  }

  const checked = [];
  for (const entry of present) checked.push({ ...entry, sync: await checkLockfile(dir, entry.file, entry.manager, manifest) });
  const chosen = checked.find((entry) => entry.sync.problems === null) ?? checked[0]!;
  const managers = new Set(present.map((entry) => entry.manager));
  if (managers.size > 1) {
    const staleOthers = checked.filter((entry) => entry !== chosen && entry.sync.problems !== null).map((entry) => entry.file);
    notes.push(
      chosen !== checked[0]
        ? `Found lockfiles for ${[...managers].join(", ")}; ${staleOthers.join(" and ")} ${staleOthers.length === 1 ? "is" : "are"} out of date with package.json, so ${chosen.manager} (${chosen.file}) is used. Delete the lockfiles you don't use.`
        : `Found lockfiles for ${[...managers].join(", ")}; using ${chosen.manager} (${chosen.file}). Delete the lockfiles you don't use.`,
    );
  }

  const { version, major, why } = inferVersion(chosen.manager, chosen.sync.format, manifest, notes);
  return {
    manager: chosen.manager,
    major,
    version,
    reason: `${chosen.file}${why ? ` (${why})` : ""} → ${chosen.manager}${version ? ` ${version}` : ""}`,
    lockfile: chosen.file,
    staleLockfile: chosen.sync.problems,
  };
}

/**
 * The version for a package manager nothing pins: the one that reads the
 * lockfile's format (and satisfies engines.<manager>, when set).
 */
export function inferVersion(
  manager: PackageManager,
  format: string | null,
  pkg: PackageJson,
  notes: string[],
): { version: string | null; major: number | null; why: string | null } {
  if (manager === "npm") return { version: null, major: null, why: null };
  if (manager === "bun") return { version: "1", major: 1, why: null };
  if (manager === "yarn") {
    if (format === null || format === "1") return { version: "1", major: 1, why: format === "1" ? "Yarn 1 lockfile" : null };
    const metadata = Number(format);
    const major = Number.isFinite(metadata) ? yarnMajorForMetadata(metadata) : 4;
    return { version: String(major), major, why: `Yarn Berry lockfile, __metadata version ${format}` };
  }

  // pnpm
  const engines = (pkg.engines as { pnpm?: unknown } | undefined)?.pnpm;
  const range = typeof engines === "string" && semver.validRange(engines) !== null ? engines : null;
  const fits = (major: number) => range === null || semver.intersects(range, `^${major}.0.0`);
  if (format === null) {
    const major = [DEFAULT_PNPM_MAJOR, 10, 11, 12].find(fits) ?? DEFAULT_PNPM_MAJOR;
    return { version: String(major), major, why: range ? `engines.pnpm "${truncate(range, 30)}"` : null };
  }
  const readers = PNPM_LOCKFILE_MAJORS[format];
  if (!readers) {
    notes.push(`pnpm-lock.yaml has lockfileVersion ${truncate(format, 20)}, newer than Shipyard knows; using the newest pnpm. Pin one with "packageManager" in package.json.`);
    return { version: "latest", major: null, why: `lockfileVersion ${truncate(format, 20)}` };
  }
  const major = readers.find(fits) ?? readers[0]!;
  if (range && !fits(major)) notes.push(`engines.pnpm "${truncate(range)}" doesn't match a pnpm that reads lockfileVersion ${format}; using pnpm ${major}.`);
  if (major < 8) notes.push(`pnpm ${major} is old and may not run on current Node; consider updating pnpm-lock.yaml with a newer pnpm.`);
  return { version: String(major), major, why: `lockfileVersion ${format}${range && fits(major) ? `, engines.pnpm "${truncate(range, 30)}"` : ""}` };
}
