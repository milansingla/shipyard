import { parse as parseYaml } from "yaml";

import { generateNodeDockerfile, generatePlainSiteDockerfile, generateStaticSiteDockerfile, GENERATED_DOCKERIGNORE, installCommand } from "./generateDockerfile.js";
import { isNestedRegularFile, isRegularFile, isSafeRelativePath, readNestedFile, readRegularFile } from "./files.js";
import {
  detectionError,
  parsePackageJson,
  resolveStartCommand,
  selectDependencyFiles,
  truncate,
  type NodeProject,
  type PackageJson,
  type PackageManager,
} from "./nodeProject.js";
import { selectNodeVersion } from "./nodeVersion.js";
import { detectPackageManager, type PackageManagerChoice } from "./packageManager.js";
import { joinRelative, type Candidate, type DetectContext, type ProjectType } from "./types.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;

/** A start script that runs a development server: not how anything should run in production. */
const DEV_SERVER = /^(?:npx\s+)?(?:vite(?:\s|$)|react-scripts\s+start|ng\s+serve|vue-cli-service\s+serve|astro\s+(?:dev|preview)|next\s+dev|nuxi?\s+dev|webpack(?:-dev-server|\s+serve)|parcel(?:\s|$))/;

/** Server frameworks, in the order they are named when several are present. */
const SERVER_FRAMEWORKS: ReadonlyArray<[dependency: string, name: string]> = [
  ["fastify", "Fastify"],
  ["express", "Express"],
  ["koa", "Koa"],
  ["hono", "Hono"],
  ["@hapi/hapi", "hapi"],
  ["restify", "Restify"],
  ["@adonisjs/core", "AdonisJS"],
];

/** UI libraries built with Vite, for naming the framework. */
const VITE_UIS: ReadonlyArray<[dependency: string, name: string]> = [
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["lit", "Lit"],
];

/** What the framework implies for the build, before package.json scripts have their say. */
interface Shape {
  framework: string | null;
  projectType: ProjectType;
  /** server = runs Node in production; static = built files served by nginx; auto = decide from scripts. */
  kind: "server" | "static" | "auto";
  /** The framework's own production server, when there is no start script. */
  frameworkStart?: string[];
  /** Script preferred over "start" (NestJS's start:prod). */
  preferredScript?: string;
  /** Static output directory relative to the package; null = find it after the build. */
  outputDir?: string | null;
  spa?: boolean;
  port?: number;
  portSource?: string;
  env?: Record<string, string>;
  reasons: string[];
}

/**
 * Node.js: package.json decides. Frameworks set sensible defaults (Next.js's
 * server, Vite's static build, NestJS's compiled entry), but the package's own
 * scripts win when present. A package inside a workspace is built from the
 * workspace root, with the workspace's lockfile, and runs from its own directory.
 */
export async function detectNode(context: DetectContext): Promise<Candidate | null> {
  const raw = await readRegularFile(context.dir, "package.json", MAX_MANIFEST_BYTES);
  if (raw === null) return null;
  const pkg = parsePackageJson(raw);
  const notes: string[] = [];
  const reasons: string[] = [`${joinRelative(context.rel, "package.json")} found`];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const workspace = await findWorkspace(context);
  const managerDir = workspace?.dir ?? context.dir;
  const managerPkg = workspace?.pkg ?? pkg;
  let choice = await detectPackageManager(managerDir, workspace ? managerPkg : pkg, notes);
  if (!workspace && context.rel !== "." && choice.lockfile === null && pkg.packageManager === undefined) {
    choice = (await inheritPackageManager(context, notes)) ?? choice;
  }
  const { manager, major, lockfile } = choice;
  reasons.push(workspace && lockfile ? `${choice.reason} (at the workspace root, ${workspace.rel})` : choice.reason);
  if (workspace) reasons.push(`part of the ${workspace.tool} workspace at ${workspace.rel}: built from there`);
  if (choice.staleLockfile) {
    notes.push(
      `${lockfile} is out of date with package.json, so \`${installCommandFor(choice)}\` will refuse it: ${choice.staleLockfile.join("; ")}. ` +
        `Run \`${manager} install\` locally and commit ${lockfile}.`,
    );
  }
  const node = await selectNodeVersion(ancestorDirs(context), pkg.engines?.node ?? workspace?.pkg?.engines?.node, notes);
  const nodeMajor = node.major;
  if (manager !== "bun") reasons.push(node.reason);

  const shape = await analyze(context, pkg, deps);
  reasons.push(...shape.reasons);

  const configuredStart = context.overrides.startCommand ?? null;
  const configuredBuild = context.overrides.buildCommand ?? null;
  const hasBuild = Boolean(pkg.scripts?.build?.trim());
  const startScript = pkg.scripts?.start?.trim() ?? "";
  let kind = shape.kind;
  if (configuredStart) kind = "server";
  else if (kind === "static" && startScript && !DEV_SERVER.test(startScript)) {
    kind = "server";
    reasons.push(`its "start" script runs its own server (${truncate(startScript, 60)})`);
  }

  let start: string[] | null = null;
  let plainSite = false;
  if (kind !== "static") {
    try {
      start = configuredStart ? ["sh", "-c", configuredStart] : await resolveStartCommand(context.dir, pkg, manager, shape.frameworkStart ?? null, shape.preferredScript ?? null);
      kind = "server";
    } catch (error) {
      // No way to start a server: a frontend that builds to static files, or plain files.
      const hasIndex = await hasIndexHtml(context.dir);
      if (kind !== "auto" || !hasIndex) throw error;
      if (hasBuild || configuredBuild) {
        kind = "static";
        reasons.push("no start command, but a build script and an index.html: built as a static site");
      } else if (await isRegularFile(context.dir, "index.html")) {
        plainSite = true;
        reasons.push("no start or build script, but an index.html: served as plain files");
      } else {
        throw error;
      }
    }
  }
  if (kind === "static" && !hasBuild && !configuredBuild) {
    throw detectionError(
      `${shape.framework ?? "This app"} builds into static files, but package.json has no "build" script. ` +
        'Add one (e.g. "build": "vite build"), or set a build command for the service.',
    );
  }

  const workdir = workspace ? relativeTo(workspace.rel, context.rel) : ".";
  const buildExec = workspace && !configuredBuild ? await workspaceBuild(workspace, manager, pkg, workdir, hasBuild) : null;
  const project: NodeProject = {
    packageManager: manager,
    packageManagerMajor: major,
    packageManagerVersion: choice.version,
    packageManagerReason: choice.reason,
    staleLockfile: choice.staleLockfile,
    lockfile,
    nodeMajor,
    // In a workspace the package is built by buildExec, never by the root's own build script.
    hasBuildScript: workspace ? false : hasBuild,
    startCommand: start ?? [],
    dependencyFiles: workspace ? null : await selectDependencyFiles(context.dir, pkg, manager, major, lockfile, notes),
    notes,
  };

  const serverDependency = SERVER_FRAMEWORKS.find(([dependency]) => dependency in deps);
  const framework = shape.framework ?? (kind === "server" ? (serverDependency?.[1] ?? null) : null);
  if (!shape.framework && serverDependency && kind === "server") reasons.push(`${serverDependency[0]} in dependencies → ${serverDependency[1]}`);
  if ("typescript" in deps) reasons.push("TypeScript: compiled by the build script (dev dependencies are installed for the build)");

  let port: number;
  let portSource: string;
  if (kind === "static" || plainSite) {
    port = 8080;
    portSource = "nginx serving the built files";
  } else if (shape.port) {
    port = shape.port;
    portSource = shape.portSource ?? `${framework} default`;
  } else {
    const listened = await listenPort(context.dir, pkg, start ?? []);
    port = listened?.port ?? 3000;
    portSource = listened ? `listen(${listened.port}) in ${listened.file}` : "Node.js default (the app gets PORT)";
  }

  const isLibraryLike = !startScript && !shape.framework && !serverDependency && kind === "server" && !configuredStart;
  const confidence = configuredStart ? 0.9 : shape.framework ? 0.95 : startScript ? 0.9 : kind === "static" || plainSite ? 0.7 : isLibraryLike ? 0.6 : 0.75;
  const displayBuild = configuredBuild ?? (buildExec ? buildExec.join(" ") : hasBuild ? `${manager} run build` : null);
  const projectType: ProjectType = kind === "static" || plainSite ? (shape.projectType === "node" ? "static" : shape.projectType) : shape.projectType;

  return {
    projectType,
    language: "Node.js",
    runtime: manager === "bun" ? `Bun ${choice.version ?? "1"}` : `Node ${nodeMajor}`,
    framework: framework ?? ("typescript" in deps ? "TypeScript" : null),
    packageManager: manager,
    entrypoint: start ? start.join(" ") : null,
    buildCommand: displayBuild,
    startCommand: plainSite || kind === "static" ? "nginx" : configuredStart ?? (start ? start.join(" ") : null),
    port,
    portSource,
    confidence,
    reasons,
    notes,
    contextDirectory: workspace?.rel ?? context.rel,
    app: !isLibraryLike,
    install: {
      manager,
      version: choice.version,
      reason: choice.reason,
      lockfile,
      command: installCommand(project),
      staleLockfile: choice.staleLockfile,
    },
    dockerfile: {
      kind: "generated",
      dockerignore: GENERATED_DOCKERIGNORE,
      render: (input) => {
        if (plainSite) return generatePlainSiteDockerfile(input.port);
        if (kind === "static") {
          return generateStaticSiteDockerfile(project, input.port, input.buildArgNames, input.buildCommand, {
            buildExec,
            workdir,
            outputDir: shape.outputDir ?? null,
            spa: shape.spa ?? true,
          });
        }
        const withStart = input.startCommand ? { ...project, startCommand: ["sh", "-c", input.startCommand] } : project;
        return generateNodeDockerfile(withStart, input.port, input.buildArgNames, input.buildCommand, { buildExec, workdir, env: shape.env ?? {} });
      },
    },
  };
}

/** Reads the framework from dependencies and its config files. */
async function analyze(context: DetectContext, pkg: PackageJson, deps: Record<string, string>): Promise<Shape> {
  const has = (name: string) => name in deps;
  const because = (dependency: string, name: string) => `${dependency} in dependencies → ${name}`;

  if (has("next")) {
    const config = await readFirst(context.dir, ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]);
    if (config && /output\s*:\s*["']export["']/.test(config.text)) {
      return { framework: "Next.js", projectType: "nextjs", kind: "static", outputDir: "out", spa: false, reasons: [because("next", "Next.js"), `${config.name} sets output: "export" → static files in out/`] };
    }
    return { framework: "Next.js", projectType: "nextjs", kind: "server", frameworkStart: ["npx", "--no-install", "next", "start"], port: 3000, portSource: "Next.js default", reasons: [because("next", "Next.js")] };
  }
  if (has("nuxt")) {
    return {
      framework: "Nuxt",
      projectType: "node",
      kind: "server",
      frameworkStart: ["node", ".output/server/index.mjs"],
      env: { HOST: "0.0.0.0" },
      port: 3000,
      portSource: "Nuxt default",
      reasons: [because("nuxt", "Nuxt"), "runs the built Nitro server (.output/server/index.mjs)"],
    };
  }
  if (has("@sveltejs/kit")) {
    if (has("@sveltejs/adapter-node")) {
      return { framework: "SvelteKit", projectType: "node", kind: "server", frameworkStart: ["node", "build"], env: { HOST: "0.0.0.0" }, port: 3000, portSource: "SvelteKit (adapter-node) default", reasons: [because("@sveltejs/kit", "SvelteKit"), "@sveltejs/adapter-node → a Node server in build/"] };
    }
    if (has("@sveltejs/adapter-static")) {
      return { framework: "SvelteKit", projectType: "static", kind: "static", outputDir: "build", reasons: [because("@sveltejs/kit", "SvelteKit"), "@sveltejs/adapter-static → static files in build/"] };
    }
    throw detectionError(
      "This is a SvelteKit app without @sveltejs/adapter-node or @sveltejs/adapter-static, so it can't run outside its usual host. " +
        "Install adapter-node (a server) or adapter-static (static files) and set it in svelte.config.js.",
    );
  }
  if (has("astro")) {
    if (has("@astrojs/node")) {
      return { framework: "Astro", projectType: "node", kind: "server", frameworkStart: ["node", "./dist/server/entry.mjs"], env: { HOST: "0.0.0.0" }, port: 4321, portSource: "Astro default", reasons: [because("astro", "Astro"), "@astrojs/node → a Node server in dist/server/"] };
    }
    return { framework: "Astro", projectType: "static", kind: "static", outputDir: "dist", spa: false, reasons: [because("astro", "Astro"), "no server adapter → static files in dist/"] };
  }
  if (has("@remix-run/node") || has("@remix-run/serve") || has("@react-router/serve")) {
    return { framework: "Remix", projectType: "node", kind: "server", port: 3000, portSource: "Remix default", reasons: ["@remix-run in dependencies → Remix"] };
  }
  if (has("@nestjs/core")) {
    return { framework: "NestJS", projectType: "node", kind: "server", preferredScript: "start:prod", frameworkStart: ["node", "dist/main"], port: 3000, portSource: "NestJS default", reasons: [because("@nestjs/core", "NestJS"), "starts with start:prod when there is one (the compiled app), else start"] };
  }
  if (has("@angular/core")) {
    const output = await angularOutput(context.dir);
    return { framework: "Angular", projectType: "static", kind: "static", outputDir: output.dir, reasons: [because("@angular/core", "Angular"), output.reason] };
  }
  if (has("gatsby")) {
    return { framework: "Gatsby", projectType: "static", kind: "static", outputDir: "public", spa: false, reasons: [because("gatsby", "Gatsby"), "static files in public/"] };
  }
  if (has("react-scripts")) {
    return { framework: "React (Create React App)", projectType: "react", kind: "static", outputDir: "build", reasons: [because("react-scripts", "Create React App"), "static files in build/"] };
  }
  if (has("@vue/cli-service")) {
    return { framework: "Vue (Vue CLI)", projectType: "vite", kind: "static", outputDir: "dist", reasons: [because("@vue/cli-service", "Vue CLI"), "static files in dist/"] };
  }
  if (has("vite")) {
    const ui = VITE_UIS.find(([dependency]) => has(dependency));
    const name = ui ? `${ui[1]} + Vite` : "Vite";
    const server = SERVER_FRAMEWORKS.find(([dependency]) => has(dependency));
    if (server) {
      // A server that also uses Vite (SSR, or serving its own frontend): the server runs.
      return { framework: `${server[1]} + Vite`, projectType: "node", kind: "server", reasons: [because("vite", "Vite"), `${server[0]} too → the server runs, Vite builds its frontend`] };
    }
    const config = await readFirst(context.dir, ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts", "vite.config.cjs"]);
    const outDir = config ? /outDir\s*:\s*["']([^"']+)["']/.exec(config.text)?.[1] : undefined;
    const safeOut = outDir && isSafeRelativePath(outDir.replace(/^\.\//, "")) ? outDir.replace(/^\.\//, "") : null;
    return {
      framework: name,
      projectType: ui?.[0] === "react" ? "react" : "vite",
      kind: "static",
      outputDir: safeOut ?? "dist",
      reasons: [because("vite", name), safeOut ? `${config!.name} sets build.outDir → ${safeOut}/` : "static files in dist/"],
    };
  }
  const server = SERVER_FRAMEWORKS.find(([dependency]) => has(dependency));
  if (server) return { framework: server[1], projectType: "node", kind: "server", reasons: [] };
  return { framework: null, projectType: "node", kind: "auto", reasons: [] };
}

/** Angular's build output: angular.json outputPath, plus /browser for the application builder (Angular 17+). */
async function angularOutput(dir: string): Promise<{ dir: string | null; reason: string }> {
  const raw = await readRegularFile(dir, "angular.json", MAX_MANIFEST_BYTES);
  if (!raw) return { dir: null, reason: "no angular.json: the output directory is found after the build" };
  try {
    const config = JSON.parse(raw) as { defaultProject?: string; projects?: Record<string, { architect?: { build?: { builder?: string; options?: { outputPath?: string | { base?: string } } } } }> };
    const names = Object.keys(config.projects ?? {});
    const name = config.defaultProject && config.projects?.[config.defaultProject] ? config.defaultProject : names[0];
    const build = name ? config.projects?.[name]?.architect?.build : undefined;
    const outputPath = build?.options?.outputPath;
    const base = typeof outputPath === "string" ? outputPath : (outputPath?.base ?? (name ? `dist/${name}` : null));
    if (!base) return { dir: null, reason: "angular.json has no outputPath: the output directory is found after the build" };
    const application = /:application$/.test(build?.builder ?? "") || build?.builder === undefined;
    const output = `${base.replace(/^\.\//, "").replace(/\/$/, "")}${application ? "/browser" : ""}`;
    if (!isSafeRelativePath(output)) return { dir: null, reason: "angular.json's outputPath isn't a plain relative path: the output directory is found after the build" };
    return { dir: output, reason: `angular.json → static files in ${output}/` };
  } catch {
    return { dir: null, reason: "angular.json couldn't be read: the output directory is found after the build" };
  }
}

/** A port hard-coded in the entry file's listen(), when the app doesn't read PORT. */
async function listenPort(dir: string, pkg: PackageJson, start: readonly string[]): Promise<{ port: number; file: string } | null> {
  let file: string | undefined;
  if (start[0] === "node" && start[1]) file = start[1];
  else {
    const script = /^node\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./@-]+\.[cm]?js)\b/.exec(pkg.scripts?.start?.trim() ?? "");
    file = script?.[1] ?? pkg.main;
  }
  if (!file) return null;
  const relative = file.replace(/^\.\//, "");
  if (!/\.[cm]?js$/.test(relative)) return null;
  const text = await readNestedFile(dir, relative, MAX_SOURCE_BYTES).catch(() => null);
  if (!text || /process\.env\.PORT|process\.env\[["']PORT["']\]/.test(text)) return null;
  const match = /\.listen\(\s*(\d{2,5})\s*[,)]/.exec(text);
  const port = match ? Number(match[1]) : NaN;
  return port >= 1 && port <= 65535 ? { port, file: relative } : null;
}

async function hasIndexHtml(dir: string): Promise<boolean> {
  return (await isRegularFile(dir, "index.html")) || (await isNestedRegularFile(dir, "public/index.html")) || (await isNestedRegularFile(dir, "src/index.html"));
}

async function readFirst(dir: string, names: readonly string[]): Promise<{ name: string; text: string } | null> {
  for (const name of names) {
    const text = await readRegularFile(dir, name, MAX_SOURCE_BYTES).catch(() => null);
    if (text !== null) return { name, text };
  }
  return null;
}

// ───────────── workspaces ─────────────

interface Workspace {
  /** Workspace root, relative to the repository root. */
  rel: string;
  dir: string;
  pkg: PackageJson | null;
  tool: string;
  /** turbo is installed and configured: it builds the package and what it depends on, in order. */
  turbo: boolean;
}

/**
 * The workspace this package belongs to: the nearest directory above it (up
 * to the repository root) whose package.json "workspaces" or
 * pnpm-workspace.yaml lists it.
 */
export async function findWorkspace(context: DetectContext): Promise<Workspace | null> {
  if (context.rel === ".") return null;
  const segments = context.rel.split("/");
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const rel = depth === 0 ? "." : segments.slice(0, depth).join("/");
    const dir = rel === "." ? context.root : `${context.root}/${rel}`;
    const patterns = await workspacePatterns(dir);
    if (!patterns) continue;
    const member = relativeTo(rel, context.rel);
    if (!patterns.globs.some((glob) => matchesWorkspaceGlob(glob, member))) continue;
    const raw = await readRegularFile(dir, "package.json", MAX_MANIFEST_BYTES).catch(() => null);
    let pkg: PackageJson | null = null;
    try {
      pkg = raw ? parsePackageJson(raw) : null;
    } catch {
      pkg = null;
    }
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const turbo = (await isRegularFile(dir, "turbo.json")) && "turbo" in deps;
    return { rel, dir, pkg, tool: turbo ? `${patterns.tool} + Turborepo` : patterns.tool, turbo };
  }
  return null;
}

/** Workspace globs declared in a directory: package.json "workspaces", or pnpm-workspace.yaml. */
export async function workspacePatterns(dir: string): Promise<{ globs: string[]; tool: string } | null> {
  const pnpm = await readRegularFile(dir, "pnpm-workspace.yaml", MAX_SOURCE_BYTES).catch(() => null);
  if (pnpm !== null) {
    try {
      const parsed = parseYaml(pnpm, { maxAliasCount: 10 }) as { packages?: unknown } | null;
      const globs = Array.isArray(parsed?.packages) ? parsed.packages.filter((item): item is string => typeof item === "string") : [];
      return { globs, tool: "pnpm" };
    } catch {
      return { globs: [], tool: "pnpm" };
    }
  }
  const raw = await readRegularFile(dir, "package.json", MAX_MANIFEST_BYTES).catch(() => null);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as { workspaces?: unknown };
    const workspaces = json.workspaces;
    const globs = Array.isArray(workspaces)
      ? workspaces
      : workspaces && typeof workspaces === "object" && Array.isArray((workspaces as { packages?: unknown }).packages)
        ? (workspaces as { packages: unknown[] }).packages
        : null;
    if (!globs) return null;
    return { globs: globs.filter((item): item is string => typeof item === "string"), tool: "npm/yarn" };
  } catch {
    return null;
  }
}

/** "apps/*" matches "apps/web"; "apps/**" anything under apps; a literal matches itself. Negations never match. */
export function matchesWorkspaceGlob(glob: string, member: string): boolean {
  const pattern = glob.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (pattern.startsWith("!") || pattern === "") return false;
  const parts = pattern.split("/");
  const segments = member.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === "**") return segments.length > index;
    const segment = segments[index];
    if (segment === undefined) return false;
    const regex = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    if (!regex.test(segment)) return false;
  }
  return segments.length === parts.length;
}

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Builds the package (and, where the tool can, the workspace packages it depends on) from the workspace root. */
async function workspaceBuild(workspace: Workspace, manager: PackageManager, pkg: PackageJson, member: string, hasBuild: boolean): Promise<string[] | null> {
  const name = pkg.name && PACKAGE_NAME.test(pkg.name) ? pkg.name : null;
  if (workspace.turbo && name) {
    const turbo = ["turbo", "run", "build", `--filter=${name}`];
    const exec: Record<PackageManager, string[]> = { npm: ["npx", "--no-install"], pnpm: ["pnpm", "exec"], yarn: ["yarn"], bun: ["bunx"] };
    return [...exec[manager], ...turbo];
  }
  if (!hasBuild) return null;
  if (manager === "npm") return ["npm", "run", "build", `--workspace=${member}`];
  if (!name) {
    throw detectionError(`The workspace package at ${member} has no valid "name" in package.json, which ${manager} needs to build it from the workspace root.`);
  }
  if (manager === "pnpm") return ["pnpm", "--filter", `${name}...`, "run", "build"];
  if (manager === "yarn") return ["yarn", "workspace", name, "run", "build"];
  return ["bun", "run", "--filter", name, "build"];
}

function installCommandFor(choice: PackageManagerChoice): string {
  return installCommand({ packageManager: choice.manager, packageManagerMajor: choice.major, lockfile: choice.lockfile });
}

/** The package's directory and each one above it, up to the repository root: where version files may be. */
function ancestorDirs(context: DetectContext): Array<{ dir: string; rel: string }> {
  const dirs = [{ dir: context.dir, rel: context.rel }];
  if (context.rel === ".") return dirs;
  const segments = context.rel.split("/");
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const rel = depth === 0 ? "." : segments.slice(0, depth).join("/");
    dirs.push({ dir: rel === "." ? context.root : `${context.root}/${rel}`, rel });
  }
  return dirs;
}

/**
 * A package in a subdirectory with no lockfile of its own and no workspace:
 * the repository still says which package manager it uses (a lockfile or
 * "packageManager" further up). That lockfile doesn't cover this package and
 * isn't in its build context, so the install isn't frozen.
 */
async function inheritPackageManager(context: DetectContext, notes: string[]): Promise<PackageManagerChoice | null> {
  for (const { dir, rel } of ancestorDirs(context).slice(1)) {
    const raw = await readRegularFile(dir, "package.json", MAX_MANIFEST_BYTES).catch(() => null);
    let pkg: PackageJson | null = null;
    try {
      pkg = raw ? parsePackageJson(raw) : null;
    } catch {
      pkg = null;
    }
    const ignored: string[] = [];
    const found = await detectPackageManager(dir, pkg, ignored).catch(() => null);
    if (!found || (found.lockfile === null && pkg?.packageManager === undefined)) continue;
    const where = rel === "." ? "the repository root" : rel;
    notes.push(
      `${context.rel} has no lockfile of its own; ${where} uses ${found.manager}, so it is installed with ${found.manager}, without a lockfile. ` +
        `Make ${context.rel} part of a workspace, or commit a lockfile in it, for reproducible builds.`,
    );
    return { ...found, reason: `${found.reason} (at ${where}; it doesn't cover ${context.rel})`, lockfile: null, staleLockfile: null };
  }
  return null;
}

/** `child` relative to `parent` (both relative to the repository root). */
function relativeTo(parent: string, child: string): string {
  if (parent === ".") return child;
  return child === parent ? "." : child.slice(parent.length + 1);
}
