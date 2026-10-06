import { argLines, assertPath, cmd, nginxConfigLines, NGINX_IMAGE, runShell } from "./dockerfileParts.js";
import type { NodeProject, PackageManager } from "./nodeProject.js";

/** What a framework or workspace changes in a generated Node Dockerfile; empty = the plain single-package app. */
export interface NodeBuildOptions {
  /** Build step in exec form instead of `<pm> run build` (a workspace build). */
  buildExec?: readonly string[] | null;
  /** Directory, inside the build context, the app runs from (a workspace package). */
  workdir?: string | null;
  /** Extra environment for the app (e.g. HOST=0.0.0.0 for servers that listen on localhost by default). */
  env?: Readonly<Record<string, string>>;
}

/**
 * Bun has its own image (tagged with the pinned version); npm, pnpm and yarn
 * run on Node. pnpm and yarn come from corepack, at the version detection
 * chose (installed below, as the build user); a pinned npm replaces the
 * image's own.
 */
function base(project: NodeProject, stage = ""): { lines: string[]; user: string } {
  if (project.packageManager === "bun") return { lines: [`FROM oven/bun:${assertVersion(project.packageManagerVersion ?? "1")}-slim${stage}`], user: "bun" };
  const lines = [
    // -slim (Debian) rather than -alpine: native modules built for glibc just work.
    `FROM node:${project.nodeMajor}-slim${stage}`,
  ];
  if (project.packageManager === "npm") {
    if (project.packageManagerVersion) {
      const spec = `npm@${assertVersion(project.packageManagerVersion)}`;
      lines.push(retriedDownload(["npm", "install", "--global", spec], spec));
    }
  } else {
    // No prompt before downloading, and never rewrite package.json to pin a version.
    lines.push("ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_AUTO_PIN=0", "RUN corepack enable");
  }
  return { lines, user: "node" };
}

/** The package manager at the chosen version, for the build user (corepack keeps it in their home). */
function packageManagerLines(project: NodeProject): string[] {
  if ((project.packageManager !== "pnpm" && project.packageManager !== "yarn") || !project.packageManagerVersion) return [];
  const spec = `${project.packageManager}@${assertVersion(project.packageManagerVersion)}`;
  // The reason quotes repository content: only plain characters reach the comment.
  return [`# ${project.packageManagerReason.replace(/[^\w .,:;()"'@/^~<>=*|+→-]/g, "")}`, retriedDownload(["corepack", "install", "--global", spec], spec)];
}

/** Attempts at a package-manager download before the build gives up. */
export const DOWNLOAD_ATTEMPTS = 5;

/**
 * A download from the npm registry, retried with growing pauses (3s, 6s, …):
 * corepack doesn't retry, and one dropped connection shouldn't fail a
 * deployment. Every word of `command` is fixed or a validated version, so
 * it is safe inside `sh -c`.
 */
function retriedDownload(command: readonly string[], what: string): string {
  const run = command.join(" ");
  const script =
    `for attempt in $(seq 1 ${DOWNLOAD_ATTEMPTS}); do ${run} && exit 0; ` +
    `[ "$attempt" -eq ${DOWNLOAD_ATTEMPTS} ] && break; ` +
    `echo "Shipyard: couldn't download ${what} (attempt $attempt of ${DOWNLOAD_ATTEMPTS}); retrying in $((attempt * 3))s" >&2; sleep $((attempt * 3)); done; ` +
    `echo "Shipyard: couldn't download ${what} from the npm registry after ${DOWNLOAD_ATTEMPTS} attempts." >&2; exit 1`;
  return `RUN ${JSON.stringify(["sh", "-c", script])}`;
}

/** Install (and build) steps shared by servers and static sites: everything up to the built source. */
function installAndBuild(project: NodeProject, user: string, buildArgNames: readonly string[], buildCommand: string | null, buildExec: readonly string[] | null): string[] {
  const lines = [
    "WORKDIR /app",
    `RUN chown ${user}:${user} /app`,
    "# Install scripts, the build and the app all run as an unprivileged user.",
    `USER ${user}`,
    ...packageManagerLines(project),
  ];
  if (project.dependencyFiles) {
    // Manifests first: Docker reuses the install layer until one of them changes.
    lines.push(
      "# Dependencies first, so the install is cached until they change",
      `COPY --chown=${user}:${user} ${project.dependencyFiles.map(assertFileName).join(" ")} ./`,
    );
  } else {
    // Whole source before install: install scripts and workspaces may need it.
    lines.push(`COPY --chown=${user}:${user} . .`);
  }
  // pnpm and yarn say which version runs (the corepack layer may be cached): a failed install is explained with it.
  const announce = project.packageManager === "pnpm" || project.packageManager === "yarn" ? `echo "Using ${project.packageManager} $(${project.packageManager} --version)" && ` : "";
  lines.push(...argLines(buildArgNames), `RUN ${announce}${installCommand(project)}`);
  if (project.dependencyFiles) lines.push(`COPY --chown=${user}:${user} . .`);
  // A configured command runs through a shell, in exec form: the JSON array keeps it one argument.
  if (buildCommand) lines.push(runShell(buildCommand));
  else if (buildExec) lines.push(`RUN ${JSON.stringify(buildExec)}`);
  else if (project.hasBuildScript) lines.push(`RUN ${project.packageManager} run build`);
  return lines;
}

/**
 * Turns a detected Node project into a Dockerfile. Pure: same input, same text.
 *
 * Every RUN line comes from a fixed template below, never from repository
 * content. The only repository-derived value, the start command, is validated
 * by detection and emitted in exec (JSON) form, so it never passes through a shell.
 */
export function generateNodeDockerfile(
  project: NodeProject,
  port: number,
  buildArgNames: readonly string[] = [],
  /** A build command configured for the service, instead of `<pm> run build`. */
  buildCommand: string | null = null,
  options: NodeBuildOptions = {},
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`Invalid port: ${port}`);

  const { lines: from, user } = base(project);
  const lines = [
    "# Generated by Shipyard from package.json.",
    "# To customise the build, commit your own Dockerfile at the repository root.",
    ...from,
    ...installAndBuild(project, user, buildArgNames, buildCommand, options.buildExec ?? null),
  ];
  if (options.workdir && options.workdir !== ".") lines.push(`WORKDIR /app/${assertPath(options.workdir)}`);
  for (const [key, value] of Object.entries(options.env ?? {})) lines.push(`ENV ${assertEnvName(key)}=${JSON.stringify(value)}`);

  lines.push(
    "ENV NODE_ENV=production",
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    `CMD ${JSON.stringify(project.startCommand)}`,
  );

  return `${lines.join("\n")}\n`;
}

/**
 * A frontend that builds to static files (Vite, Create React App, Angular,
 * Astro, …): built with Node, then served by nginx, so no Node and no dev
 * server run in production. `outputDir` (inside the build context) is where
 * the build writes the site; null = look for the first of dist/, build/,
 * out/, public/ with an index.html, after the build.
 */
export function generateStaticSiteDockerfile(
  project: NodeProject,
  port: number,
  buildArgNames: readonly string[],
  buildCommand: string | null,
  options: { buildExec?: readonly string[] | null; workdir: string; outputDir: string | null; spa: boolean },
): string {
  const { lines: from, user } = base(project, " AS build");
  const lines = [
    "# Generated by Shipyard from package.json: builds the site, then serves the files with nginx.",
    "# To customise the build, commit your own Dockerfile.",
    ...from,
    ...installAndBuild(project, user, buildArgNames, buildCommand, options.buildExec ?? null),
  ];
  const appDir = options.workdir === "." ? "/app" : `/app/${assertPath(options.workdir)}`;
  let site: string;
  if (options.outputDir) {
    site = `${appDir}/${assertPath(options.outputDir)}`;
  } else {
    site = "/app/.shipyard-site";
    lines.push(
      "# The build's output: the first of these with an index.html",
      `RUN ${JSON.stringify([
        "sh",
        "-c",
        `cd ${appDir} && for d in dist build out public; do if [ -f "$d/index.html" ]; then cp -R "$d" /app/.shipyard-site; exit 0; fi; done; echo "The build produced no dist/, build/, out/ or public/ with an index.html. Set a build command, or add a Dockerfile." >&2; exit 1`,
      ])}`,
    );
  }
  lines.push(
    `FROM ${NGINX_IMAGE}`,
    ...nginxConfigLines(port, options.spa),
    `COPY --from=build ${site} /usr/share/nginx/html`,
    `EXPOSE ${port}`,
  );
  return `${lines.join("\n")}\n`;
}

/** Plain HTML/CSS/JS with no build: the directory itself, served by nginx (dotfiles never served). */
export function generatePlainSiteDockerfile(port: number): string {
  return `${[
    "# Generated by Shipyard: serves this directory's files with nginx.",
    "# To customise it, commit your own Dockerfile.",
    `FROM ${NGINX_IMAGE}`,
    ...nginxConfigLines(port, false),
    "COPY . /usr/share/nginx/html",
    "USER root",
    "RUN rm -f /usr/share/nginx/html/.shipyard.Dockerfile /usr/share/nginx/html/.dockerignore",
    "USER 101",
    `EXPOSE ${port}`,
    cmd(["nginx", "-g", "daemon off;"]),
  ].join("\n")}\n`;
}

/** A package-manager version: "9", "9.15.0", "9.15.0-rc.1" or "latest". */
function assertVersion(version: string): string {
  if (!/^(?:latest|\d+(?:\.\d+){0,2}(?:-[\w.-]+)?)$/.test(version)) throw new RangeError(`Invalid package manager version: ${version}`);
  return version;
}

function assertEnvName(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new RangeError(`Invalid environment variable name: ${name}`);
  return name;
}

/** Dependency files come from a fixed list (package.json, lockfiles, rc files); refuse anything else. */
function assertFileName(name: string): string {
  if (!/^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new RangeError(`Invalid dependency file name: ${name}`);
  return name;
}

/** Ignore rules written only when the repository has no .dockerignore of its own. */
export const GENERATED_DOCKERIGNORE = [
  "# Generated by Shipyard.",
  // Host node_modules may hold binaries for the wrong OS/CPU; always install fresh.
  "node_modules",
  ".git",
  "npm-debug.log*",
  "",
].join("\n");

/** Dev dependencies are installed too: most build scripts need them. */
export function installCommand(project: Pick<NodeProject, "packageManager" | "packageManagerMajor" | "lockfile">): string {
  const locked = project.lockfile !== null;
  const commands: Record<PackageManager, string> = {
    npm: locked ? "npm ci" : "npm install",
    pnpm: locked ? "pnpm install --frozen-lockfile" : "pnpm install",
    yarn: !locked
      ? "yarn install"
      : (project.packageManagerMajor ?? 1) >= 2
        ? "yarn install --immutable"
        : "yarn install --frozen-lockfile",
    bun: locked ? "bun install --frozen-lockfile" : "bun install",
  };
  return commands[project.packageManager];
}
