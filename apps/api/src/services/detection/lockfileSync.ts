import semver from "semver";
import { parse as parseYaml } from "yaml";

import { isSafeRelativePath, readNestedFile, readRegularFile } from "./files.js";
import type { PackageJson, PackageManager } from "./nodeProject.js";

/**
 * Does a lockfile still match package.json? Each check mirrors the one the
 * package manager's own frozen install makes, so "out of date" here means the
 * install in the image will refuse it, and the build log can say why before
 * Docker runs. Anything this can't read confidently counts as in sync: a check
 * that guesses would warn about lockfiles that are fine.
 */

const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Mismatches listed before "and N more". */
const MAX_LISTED = 8;

export interface LockfileSync {
  /** null = in sync (or not checkable). */
  problems: string[] | null;
  /** pnpm: lockfileVersion; yarn: "1" or the Berry __metadata version. Picks a compatible version when none is pinned. */
  format: string | null;
}

type Dependencies = Record<string, string>;

const IN_SYNC: LockfileSync = { problems: null, format: null };

/**
 * `dir` holds the lockfile and the package.json it was made for (the
 * workspace root, for a workspace).
 */
export async function checkLockfile(dir: string, lockfile: string, manager: PackageManager, pkg: PackageJson): Promise<LockfileSync> {
  if (lockfile === "bun.lockb") return IN_SYNC; // binary
  const text = await readRegularFile(dir, lockfile, MAX_LOCKFILE_BYTES).catch(() => null);
  if (text === null) return IN_SYNC;
  try {
    if (manager === "pnpm") return await checkPnpm(dir, text, pkg);
    if (manager === "npm") return await checkNpm(dir, text, pkg);
    if (manager === "yarn") return await checkYarn(dir, text, pkg);
    return await checkBun(dir, text, pkg);
  } catch {
    return IN_SYNC;
  }
}

/** Direct dependencies a lockfile pins for one package. */
function manifestDependencies(pkg: PackageJson | Record<string, unknown>): Dependencies {
  const record = pkg as { dependencies?: unknown; devDependencies?: unknown; optionalDependencies?: unknown };
  return { ...asRecord(record.optionalDependencies), ...asRecord(record.devDependencies), ...asRecord(record.dependencies) };
}

function asRecord(value: unknown): Dependencies {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** A workspace member's package.json, read relative to the lockfile's directory. */
async function memberManifest(dir: string, member: string): Promise<Record<string, unknown> | null> {
  if (member === "." || member === "" || !isSafeRelativePath(member)) return null;
  const raw = await readNestedFile(dir, `${member}/package.json`, MAX_MANIFEST_BYTES).catch(() => null);
  if (raw === null) return null;
  const json = JSON.parse(raw) as unknown;
  return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
}

function finish(problems: string[], format: string | null): LockfileSync {
  if (problems.length === 0) return { problems: null, format };
  const listed = problems.slice(0, MAX_LISTED);
  if (problems.length > MAX_LISTED) listed.push(`and ${problems.length - MAX_LISTED} more`);
  return { problems: listed, format };
}

function where(member: string): string {
  return member === "." ? "" : ` (${member})`;
}

// ───────────── pnpm ─────────────

/**
 * pnpm compares each importer's specifiers with package.json literally (the
 * ERR_PNPM_OUTDATED_LOCKFILE check). Only the part before `packages:` is
 * parsed: it holds every importer, and the rest can be megabytes.
 */
async function checkPnpm(dir: string, text: string, pkg: PackageJson): Promise<LockfileSync> {
  const head = text.split(/^packages:/m)[0] ?? text;
  const lock = parseYaml(head, { maxAliasCount: 100 }) as Record<string, unknown> | null;
  if (!lock || typeof lock !== "object") return IN_SYNC;
  const format = lock.lockfileVersion === undefined ? null : String(lock.lockfileVersion);
  const overridden = new Set(Object.keys(asRecord(lock.overrides)));

  const importers = new Map<string, Dependencies>();
  const declared = lock.importers;
  if (declared && typeof declared === "object") {
    for (const [member, importer] of Object.entries(declared as Record<string, unknown>)) importers.set(member, pnpmSpecifiers(importer));
  } else {
    importers.set(".", pnpmSpecifiers(lock));
  }

  const problems: string[] = [];
  for (const [member, locked] of importers) {
    if (member !== "." && !isSafeRelativePath(member)) continue;
    const manifest = member === "." ? pkg : await memberManifest(dir, member);
    if (manifest === null) {
      problems.push(`the lockfile lists ${member}, which has no package.json`);
      continue;
    }
    // With auto-install-peers, pnpm may record a package's own peer dependencies too.
    const peers = new Set(Object.keys(asRecord((manifest as { peerDependencies?: unknown }).peerDependencies)));
    problems.push(...compareSpecifiers(manifestDependencies(manifest), locked, overridden, where(member), peers));
  }
  return finish(problems, format);
}

/** An importer's specifiers: lockfile v5 keeps them in `specifiers`, v6+ next to each version. */
function pnpmSpecifiers(importer: unknown): Dependencies {
  if (!importer || typeof importer !== "object") return {};
  const record = importer as Record<string, unknown>;
  if (record.specifiers && typeof record.specifiers === "object") return asRecord(record.specifiers);
  const specifiers: Dependencies = {};
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const entries = record[field];
    if (!entries || typeof entries !== "object") continue;
    for (const [name, entry] of Object.entries(entries as Record<string, unknown>)) {
      const specifier = entry && typeof entry === "object" ? (entry as { specifier?: unknown }).specifier : undefined;
      if (typeof specifier === "string") specifiers[name] = specifier;
    }
  }
  return specifiers;
}

function compareSpecifiers(manifest: Dependencies, locked: Dependencies, skip: ReadonlySet<string>, suffix: string, alsoAllowed: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(manifest)) {
    if (skip.has(name)) continue;
    const pinned = locked[name];
    if (pinned === undefined) problems.push(`${name}@${spec} is in package.json${suffix} but not in the lockfile`);
    else if (pinned !== spec) problems.push(`${name}: package.json${suffix} wants ${spec}, the lockfile has ${pinned}`);
  }
  for (const [name, pinned] of Object.entries(locked)) {
    if (!skip.has(name) && !alsoAllowed.has(name) && !(name in manifest)) problems.push(`${name}@${pinned} is in the lockfile but no longer in package.json${suffix}`);
  }
  return problems;
}

// ───────────── npm ─────────────

/**
 * `npm ci` refuses a lockfile that is missing a dependency of package.json,
 * or whose locked version doesn't satisfy its range. Extra entries are fine.
 */
async function checkNpm(dir: string, text: string, pkg: PackageJson): Promise<LockfileSync> {
  const lock = JSON.parse(text) as { lockfileVersion?: unknown; packages?: Record<string, { version?: unknown; link?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
  const format = lock.lockfileVersion === undefined ? null : String(lock.lockfileVersion);
  const problems: string[] = [];

  if (lock.packages && typeof lock.packages === "object") {
    const packages = lock.packages;
    const members = Object.keys(packages).filter((key) => key !== "" && !key.includes("node_modules/") && !key.startsWith("node_modules"));
    for (const member of [".", ...members]) {
      const manifest = member === "." ? pkg : await memberManifest(dir, member);
      if (manifest === null) continue;
      for (const [name, spec] of Object.entries(manifestDependencies(manifest))) {
        const entry = (member === "." ? undefined : packages[`${member}/node_modules/${name}`]) ?? packages[`node_modules/${name}`];
        if (!entry) problems.push(`${name}@${spec} is in package.json${where(member)} but not in the lockfile`);
        else if (!entry.link && !satisfies(entry.version, spec)) problems.push(`${name}: package.json${where(member)} wants ${spec}, the lockfile has ${String(entry.version)}`);
      }
    }
  } else if (lock.dependencies && typeof lock.dependencies === "object") {
    // lockfileVersion 1: a tree of dependencies, no workspaces.
    for (const [name, spec] of Object.entries(manifestDependencies(pkg))) {
      const entry = lock.dependencies[name];
      if (!entry) problems.push(`${name}@${spec} is in package.json but not in the lockfile`);
      else if (!satisfies(entry.version, spec)) problems.push(`${name}: package.json wants ${spec}, the lockfile has ${String(entry.version)}`);
    }
  }
  return finish(problems, format);
}

/** Only plain semver ranges are compared; tags, URLs, aliases and file: specs just have to be present. */
function satisfies(version: unknown, spec: string): boolean {
  if (typeof version !== "string" || semver.valid(version) === null) return true;
  if (spec.trim() === "" || spec === "*" || semver.validRange(spec) === null) return true;
  return semver.satisfies(version, spec, { includePrerelease: true });
}

// ───────────── yarn ─────────────

/**
 * Yarn keys each lockfile entry by the requests it satisfies ("react@^18.2.0",
 * or "react@npm:^18.2.0" in Yarn 2+). A request in package.json with no entry
 * makes `yarn install --frozen-lockfile` / `--immutable` fail.
 */
async function checkYarn(dir: string, text: string, pkg: PackageJson): Promise<LockfileSync> {
  const berry = /^__metadata:/m.test(text);
  const format = berry ? (/^__metadata:\s*\n\s+version:\s*(\d+)/m.exec(text)?.[1] ?? "berry") : "1";
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith(" ") || line.startsWith("#") || !line.endsWith(":")) continue;
    for (const key of line.slice(0, -1).split(/,\s*/)) keys.add(key.trim().replace(/^"|"$/g, ""));
  }

  const resolutions = new Set(Object.keys(asRecord((pkg as { resolutions?: unknown }).resolutions)).map((key) => key.split("/").pop()!));
  const problems: string[] = [];
  const members: Array<[string, Record<string, unknown> | PackageJson]> = [[".", pkg]];
  if (berry) {
    // Workspace members appear as "name@workspace:path".
    for (const key of keys) {
      const member = /^(?:@[^@/]+\/)?[^@]+@workspace:(.+)$/.exec(key)?.[1];
      if (member && member !== ".") {
        const manifest = await memberManifest(dir, member);
        if (manifest) members.push([member, manifest]);
      }
    }
  }
  for (const [member, manifest] of members) {
    for (const [name, spec] of Object.entries(manifestDependencies(manifest))) {
      if (resolutions.has(name) || spec.startsWith("workspace:") || spec.startsWith("portal:") || spec.startsWith("link:") || spec.startsWith("file:")) continue;
      const request = berry && !/^[a-z]+:/.test(spec) ? `npm:${spec}` : spec;
      if (!keys.has(`${name}@${request}`)) problems.push(`${name}@${spec} (package.json${where(member)}) has no entry in the lockfile`);
    }
  }
  return finish(problems, format);
}

// ───────────── bun ─────────────

/** bun.lock (Bun 1.2+) is JSON with trailing commas; each workspace keeps its package.json dependencies. */
async function checkBun(dir: string, text: string, pkg: PackageJson): Promise<LockfileSync> {
  const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as { lockfileVersion?: unknown; workspaces?: Record<string, Record<string, unknown>> };
  if (!lock.workspaces || typeof lock.workspaces !== "object") return IN_SYNC;
  const problems: string[] = [];
  for (const [key, workspace] of Object.entries(lock.workspaces)) {
    const member = key === "" ? "." : key;
    const manifest = member === "." ? pkg : await memberManifest(dir, member);
    if (manifest === null) continue;
    problems.push(...compareSpecifiers(manifestDependencies(manifest), manifestDependencies(workspace), new Set(), where(member)));
  }
  return finish(problems, lock.lockfileVersion === undefined ? null : String(lock.lockfileVersion));
}
