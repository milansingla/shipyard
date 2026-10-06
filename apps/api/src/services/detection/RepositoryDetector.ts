import fs from "node:fs/promises";
import path from "node:path";

import { AppError, ErrorCode } from "../../lib/errors.js";
import { detectGo, detectJava, detectRust } from "./compiled.js";
import { dockerignore } from "./dockerfileParts.js";
import { isNestedDirectory, isRegularFile, listEntries } from "./files.js";
import { generatePlainSiteDockerfile } from "./generateDockerfile.js";
import { detectNode, workspacePatterns } from "./node.js";
import { detectPhp } from "./php.js";
import { detectPython } from "./python.js";
import { composeCandidate, detectRepositoryDockerfile, readCompose } from "./repositoryDockerfile.js";
import { isUnsupported, type BuildOverrides, type Candidate, type DetectContext, type Detector } from "./types.js";

/** Language detectors, in the order they win ties. */
const LANGUAGES: ReadonlyArray<{ language: string; detect: Detector }> = [
  { language: "Node.js", detect: detectNode },
  { language: "Python", detect: detectPython },
  { language: "PHP", detect: detectPhp },
  { language: "Go", detect: detectGo },
  { language: "Java", detect: detectJava },
  { language: "Rust", detect: detectRust },
  { language: "static site", detect: detectPlainSite },
];

/** Projects Shipyard recognises but doesn't generate Dockerfiles for. */
const RECOGNISED_ONLY: ReadonlyArray<{ test: (files: string[]) => boolean; name: string }> = [
  { test: (f) => f.includes("Gemfile"), name: "Ruby (Gemfile)" },
  { test: (f) => f.some((n) => /\.(csproj|fsproj|sln)$/.test(n)), name: ".NET (*.csproj / *.sln)" },
  { test: (f) => f.includes("mix.exs"), name: "Elixir (mix.exs)" },
  { test: (f) => f.includes("deno.json") || f.includes("deno.jsonc"), name: "Deno (deno.json)" },
  { test: (f) => f.includes("pubspec.yaml"), name: "Dart (pubspec.yaml)" },
  { test: (f) => f.includes("Package.swift"), name: "Swift (Package.swift)" },
  { test: (f) => f.includes("build.sbt"), name: "Scala (build.sbt)" },
];

/** Never services: dependencies, build output, caches. */
const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".cache", "dist", "build", "out",
  ".venv", "venv", "env", "__pycache__", "target", "vendor", "coverage", "tmp", "docs", "examples", "test", "tests",
]);
/** Directories a monorepo's services usually live in (each child is a candidate). */
const CONTAINERS = ["apps", "services", "packages"];
/** Directory names that are services themselves. */
const WELL_KNOWN = ["frontend", "backend", "server", "client", "web", "api", "app", "site", "website", "www", "ui"];
/** Upper bound on directories examined when looking for the service. */
const MAX_CANDIDATE_DIRECTORIES = 40;
/** Below this, a root candidate is a guess: Shipyard first looks for a clearer service in subdirectories. */
const CONFIDENT = 0.7;

export interface DetectionOutcome {
  candidate: Candidate;
  /** The service directory, relative to the repository root. */
  serviceDirectory: string;
}

/**
 * Decides how to build a service from a cloned repository. Order:
 *   1. the repository's own Dockerfile (in the service directory),
 *   2. a docker-compose file that builds exactly one service,
 *   3. language and framework detection (Node.js, Python, PHP, Go, Java,
 *      Rust, static sites), from the service's configured settings first.
 * With no configured source directory, a repository root that isn't an app
 * itself (a monorepo) is searched for the service in its usual places
 * (workspaces, apps/*, services/*, frontend/, backend/, …). One application
 * found → that one; several → an error naming them, since deploying the
 * wrong one silently is worse than asking.
 *
 * Reads only: nothing is written and nothing in the repository is run.
 */
export async function detectRepository(input: { root: string; serviceDir: string; overrides?: BuildOverrides }): Promise<DetectionOutcome> {
  const root = await fs.realpath(input.root);
  const dir = await fs.realpath(input.serviceDir);
  const rel = path.relative(root, dir).split(path.sep).join("/") || ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new AppError(ErrorCode.PROJECT_DETECTION_FAILED, "The service's directory is outside the repository.", { statusCode: 422 });
  }
  const overrides = input.overrides ?? {};
  const here = await probe({ root, dir, rel, overrides });

  // A configured directory: that directory, and only that one.
  if (rel !== ".") {
    if (here.candidate) return { candidate: here.candidate, serviceDirectory: rel };
    throw here.failures[0] ?? noApplication([rel], here.findings, false);
  }

  if (here.candidate && here.candidate.app && here.candidate.confidence >= CONFIDENT) return { candidate: here.candidate, serviceDirectory: "." };

  // The root isn't (clearly) an app: look for the service in a monorepo layout.
  const directories = await serviceDirectories(root, here.composeContexts);
  const apps: Array<{ rel: string; candidate: Candidate }> = [];
  const findings = [...here.findings];
  const failures: AppError[] = [];
  for (const candidateDir of directories) {
    const found = await probe({ root, dir: path.join(root, candidateDir), rel: candidateDir, overrides });
    if (found.candidate?.app && found.candidate.confidence >= CONFIDENT) apps.push({ rel: candidateDir, candidate: found.candidate });
    else {
      for (const failure of found.failures) {
        failures.push(failure);
        findings.push(`${candidateDir}: ${failure.message}`);
      }
      findings.push(...found.findings.map((finding) => `${candidateDir}: ${finding}`));
    }
  }

  if (apps.length === 1) {
    const only = apps[0]!;
    only.candidate.reasons.unshift(`the repository root isn't an app itself; the only service found is in ${only.rel}`);
    return { candidate: only.candidate, serviceDirectory: only.rel };
  }
  if (apps.length > 1) throw multipleServices(apps);
  if (here.candidate) return { candidate: here.candidate, serviceDirectory: "." };
  if (here.failures[0]) throw here.failures[0];
  if (failures.length === 1 && findings.length === 1) throw prefixed(failures[0]!, findings[0]!);
  throw noApplication([".", ...directories], findings, true);
}

interface Probe {
  candidate: Candidate | null;
  failures: AppError[];
  /** Why recognisable projects were not used ("a Python library", "Ruby isn't supported"). */
  findings: string[];
  /** Build contexts of a compose file that builds several services. */
  composeContexts: string[];
}

/** Everything one directory could be built as; the most certain candidate wins. */
async function probe(context: DetectContext): Promise<Probe> {
  const dockerfile = await detectRepositoryDockerfile(context);
  if (dockerfile) return { candidate: dockerfile, failures: [], findings: [], composeContexts: [] };

  const compose = await readCompose(context);
  if (compose) {
    const single = await composeCandidate(context, compose);
    if (single) return { candidate: single, failures: [], findings: [], composeContexts: [] };
  }

  const candidates: Candidate[] = [];
  const failures: AppError[] = [];
  const findings: string[] = [];
  for (const { language, detect } of LANGUAGES) {
    if (language === "static site" && candidates.length > 0) break;
    try {
      const result = await detect(context);
      if (isUnsupported(result)) findings.push(result.unsupported);
      else if (result) candidates.push(result);
    } catch (error) {
      if (error instanceof AppError) failures.push(error);
      else throw error;
    }
  }
  const files = (await listEntries(context.dir, 500)).filter((entry) => entry.kind === "file").map((entry) => entry.name);
  for (const known of RECOGNISED_ONLY) {
    if (known.test(files)) findings.push(`found a ${known.name} project: Shipyard doesn't generate Dockerfiles for it yet; add a Dockerfile`);
  }

  const best = [...candidates].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  if (best && candidates.length > 1) {
    best.reasons.push(`also looks like ${candidates.filter((c) => c !== best).map((c) => c.language).join(", ")}; ${best.language} is the clearer match`);
  }
  if (best) return { candidate: best, failures: [], findings, composeContexts: [] };
  if (compose && compose.built.length > 1) {
    findings.push(`${compose.file} builds ${compose.built.length} services (${compose.built.map((s) => s.name).join(", ")})`);
  }
  return { candidate: null, failures, findings, composeContexts: compose?.built.map((service) => service.context) ?? [] };
}

/** A directory of plain HTML/CSS/JS (no package.json): served as it is by nginx. */
async function detectPlainSite(context: DetectContext): Promise<Candidate | null> {
  if (!(await isRegularFile(context.dir, "index.html")) || (await isRegularFile(context.dir, "package.json"))) return null;
  return {
    projectType: "static",
    language: "HTML",
    framework: null,
    runtime: "nginx",
    packageManager: null,
    entrypoint: "index.html",
    buildCommand: null,
    startCommand: "nginx",
    port: 8080,
    portSource: "nginx serving the files",
    confidence: 0.75,
    reasons: ["index.html and no build: a static site, served as it is"],
    notes: [],
    contextDirectory: context.rel,
    app: true,
    dockerfile: { kind: "generated", dockerignore: dockerignore(), render: (input) => generatePlainSiteDockerfile(input.port) },
  };
}

/**
 * Where a monorepo's services are, in a fixed order: workspace packages
 * (package.json workspaces / pnpm-workspace.yaml), apps/*, services/*,
 * well-known names (frontend, backend, web, api, …), packages/*, plus build
 * contexts named by a compose file. Never dependency or build directories,
 * never symlinks, at most MAX_CANDIDATE_DIRECTORIES.
 */
export async function serviceDirectories(root: string, extra: readonly string[] = []): Promise<string[]> {
  const found: string[] = [];
  const add = async (relative: string) => {
    if (found.length >= MAX_CANDIDATE_DIRECTORIES || found.includes(relative) || relative === ".") return;
    const segments = relative.split("/");
    if (segments.some((segment) => segment.startsWith(".") || IGNORED_DIRECTORIES.has(segment))) return;
    if (await isNestedDirectory(root, relative)) found.push(relative);
  };
  const children = async (container: string) => {
    for (const entry of await listEntries(path.join(root, container), 200)) {
      if (entry.kind === "directory") await add(`${container}/${entry.name}`);
    }
  };

  const patterns = (await workspacePatterns(root))?.globs ?? [];
  for (const glob of patterns) {
    const cleaned = glob.trim().replace(/^\.\//, "").replace(/\/$/, "");
    if (cleaned.startsWith("!") || cleaned === "") continue;
    const wildcard = /^([A-Za-z0-9_.-]+)\/\*{1,2}$/.exec(cleaned);
    if (wildcard?.[1]) await children(wildcard[1]);
    else if (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(cleaned)) await add(cleaned);
  }
  for (const container of CONTAINERS.filter((c) => c !== "packages")) await children(container);
  for (const name of WELL_KNOWN) await add(name);
  await children("packages");
  for (const context of extra) await add(context);
  return found;
}

function multipleServices(apps: ReadonlyArray<{ rel: string; candidate: Candidate }>): AppError {
  const sorted = [...apps].sort((a, b) => a.rel.localeCompare(b.rel));
  const describe = (candidate: Candidate) => (candidate.framework ? `${candidate.framework} (${candidate.language})` : candidate.language);
  const name = (rel: string) => (rel.split("/").pop() ?? rel).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "service";
  return new AppError(
    ErrorCode.PROJECT_DETECTION_FAILED,
    [
      `Found ${apps.length} deployable services in this repository:`,
      ...sorted.map((app) => `  - ${app.rel}: ${describe(app.candidate)}`),
      "Shipyard won't guess which one this service is. Set the service's source directory (its settings), or declare them all in shipyard.yaml:",
      "  services:",
      ...sorted.flatMap((app) => [`    ${name(app.rel)}:`, `      source: ${app.rel}`]),
    ].join("\n"),
    { statusCode: 422 },
  );
}

function noApplication(looked: readonly string[], findings: readonly string[], searched: boolean): AppError {
  const where =
    looked.length === 1
      ? looked[0] === "."
        ? "the repository root"
        : looked[0]
      : `the repository root and ${looked.length - 1} likely service director${looked.length === 2 ? "y" : "ies"} (${looked.slice(1, 6).join(", ")}${looked.length > 6 ? ", …" : ""})`;
  return new AppError(
    ErrorCode.DOCKERFILE_NOT_FOUND,
    [
      "No supported application detected.",
      `Checked ${where} for:`,
      "  - a Dockerfile (Dockerfile, Dockerfile.*, or one built by docker-compose)",
      "  - Node.js (package.json), Python (requirements.txt, pyproject.toml, Pipfile), PHP (composer.json, index.php)",
      "  - Go (go.mod), Java (pom.xml, build.gradle), Rust (Cargo.toml), a static site (index.html)",
      ...(findings.length > 0 ? ["Found:", ...[...new Set(findings)].slice(0, 8).map((finding) => `  - ${finding}`)] : []),
      searched
        ? "Add a Dockerfile, or set the service's source directory if the app lives in a subdirectory Shipyard didn't check."
        : "Add a Dockerfile to this directory, or check the service's source directory.",
    ].join("\n"),
    { statusCode: 422 },
  );
}

function prefixed(error: AppError, message: string): AppError {
  return new AppError(error.code, message, { statusCode: error.statusCode });
}
