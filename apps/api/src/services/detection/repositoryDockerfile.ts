import path from "node:path";

import { parse as parseYaml } from "yaml";

import { parseExposedPort } from "./dockerfile.js";
import { isNestedRegularFile, isSafeRelativePath, listEntries, readNestedFile, readRegularFile } from "./files.js";
import { joinRelative, type Candidate, type DetectContext } from "./types.js";

const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const RESERVED = ".shipyard.Dockerfile";

/**
 * The repository's own Dockerfile: `Dockerfile` (or `dockerfile`), else one
 * unambiguous variant (`Dockerfile.prod`, `api.Dockerfile`, …). The user is
 * in control, so nothing is generated.
 *
 * A Dockerfile in a subdirectory of a monorepo often expects the repository
 * root as its build context (`COPY apps/web ./apps/web`). When its COPY
 * sources exist at the root but not next to it, the root is used.
 */
export async function detectRepositoryDockerfile(context: DetectContext): Promise<Candidate | null> {
  const found = await findDockerfile(context.dir);
  if (!found) return null;
  const reasons = [`${joinRelative(context.rel, found.name)} found: the repository's own build is used`];
  if (found.note) reasons.push(found.note);

  let contextDirectory = context.rel;
  let dockerfilePath = found.name;
  if (context.rel !== "." && (await needsRootContext(context, found.text))) {
    contextDirectory = ".";
    dockerfilePath = joinRelative(context.rel, found.name);
    reasons.push(`its COPY paths are relative to the repository root, so it is built from there`);
  }
  const exposed = parseExposedPort(found.text);
  return {
    projectType: "docker",
    language: "Dockerfile",
    framework: null,
    runtime: null,
    packageManager: null,
    entrypoint: null,
    buildCommand: null,
    startCommand: context.overrides.startCommand ?? null,
    port: exposed ?? 3000,
    portSource: exposed ? "EXPOSE in the Dockerfile" : "no EXPOSE in the Dockerfile: assumed",
    confidence: 0.99,
    reasons,
    notes: [],
    contextDirectory,
    app: true,
    dockerfile: { kind: "repository", path: dockerfilePath, exposedPort: exposed },
  };
}

/** The Dockerfile to use in `dir`, by its exact name (the build daemon is case-sensitive even when the disk isn't). */
export async function findDockerfile(dir: string): Promise<{ name: string; text: string; note?: string } | null> {
  const files = (await listEntries(dir)).filter((entry) => entry.kind === "file").map((entry) => entry.name);
  for (const name of ["Dockerfile", "dockerfile"]) {
    if (!files.includes(name)) continue;
    const text = await readRegularFile(dir, name, MAX_DOCKERFILE_BYTES);
    if (text !== null) return { name, text };
  }
  const variants = files.filter((name) => name !== RESERVED && (/^Dockerfile\.[A-Za-z0-9._-]+$/.test(name) || /^[A-Za-z0-9._-]+\.[Dd]ockerfile$/.test(name)));
  if (variants.length === 0) return null;
  const valid: Array<{ name: string; text: string }> = [];
  for (const name of variants) {
    const text = await readRegularFile(dir, name, MAX_DOCKERFILE_BYTES);
    if (text !== null && /^\s*FROM\s+\S+/im.test(text)) valid.push({ name, text });
  }
  const production = valid.filter((v) => /prod/i.test(v.name));
  const notDevelopment = valid.filter((v) => !/(^|[._-])(dev|development|test|local|ci|debug)([._-]|$)/i.test(v.name));
  const choice = production.length === 1 ? production[0] : notDevelopment.length === 1 ? notDevelopment[0] : valid.length === 1 ? valid[0] : undefined;
  if (!choice) return null;
  return { ...choice, note: valid.length > 1 ? `chose ${choice.name} among ${valid.map((v) => v.name).join(", ")}` : undefined };
}

/** True when the Dockerfile's COPY/ADD sources are found at the repository root and not in its own directory. */
async function needsRootContext(context: DetectContext, text: string): Promise<boolean> {
  const sources: string[] = [];
  for (const match of text.matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gim)) {
    const args = (match[1] ?? "").trim();
    if (/--from=/i.test(args) || args.startsWith("[")) continue;
    const parts = args.split(/\s+/).filter((part) => !part.startsWith("--"));
    sources.push(...parts.slice(0, -1));
  }
  let rootOnly = 0;
  for (const source of sources) {
    const first = source.replace(/^\.\//, "").split("/")[0] ?? "";
    if (first === "" || first === "." || /[*?[]/.test(first) || !isSafeRelativePath(first)) continue;
    const here = (await isNestedRegularFile(context.dir, first)) || (await existsDir(context.dir, first));
    const atRoot = (await isNestedRegularFile(context.root, first)) || (await existsDir(context.root, first));
    if (here) return false;
    if (atRoot) rootOnly += 1;
  }
  return rootOnly > 0;
}

async function existsDir(dir: string, name: string): Promise<boolean> {
  return (await listEntries(dir)).some((entry) => entry.kind === "directory" && entry.name === name);
}

// ───────────── docker-compose ─────────────

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export interface ComposeService {
  name: string;
  /** Build context relative to the repository root. */
  context: string;
  dockerfile: string;
  port: number | null;
}

/**
 * Reads a compose file without running it: which services it builds (and
 * from which Dockerfile), and which it only pulls (databases, caches).
 * Shipyard never runs `docker compose`; a compose file just points at the
 * Dockerfiles to use.
 */
export async function readCompose(context: DetectContext): Promise<{ file: string; built: ComposeService[]; images: string[] } | null> {
  for (const file of COMPOSE_FILES) {
    const raw = await readRegularFile(context.dir, file, 256 * 1024).catch(() => null);
    if (raw === null) continue;
    let document: unknown;
    try {
      document = parseYaml(raw, { maxAliasCount: 50 });
    } catch {
      return { file, built: [], images: [] };
    }
    const services = (document as { services?: Record<string, unknown> } | null)?.services;
    if (!services || typeof services !== "object") return { file, built: [], images: [] };
    const built: ComposeService[] = [];
    const images: string[] = [];
    for (const [name, value] of Object.entries(services)) {
      const service = (value ?? {}) as { build?: unknown; image?: unknown; ports?: unknown; expose?: unknown };
      if (service.build === undefined) {
        if (typeof service.image === "string") images.push(`${name} (${service.image})`);
        continue;
      }
      const build = typeof service.build === "string" ? { context: service.build } : (service.build as { context?: unknown; dockerfile?: unknown });
      const relativeContext = path.posix.normalize(joinRelative(context.rel, String(build.context ?? ".").replace(/^\.\/?/, "") || "."));
      const dockerfile = path.posix.normalize(String(build.dockerfile ?? "Dockerfile"));
      if (relativeContext.startsWith("..") || path.posix.isAbsolute(relativeContext) || !isSafeRelativePath(relativeContext)) continue;
      if (dockerfile.startsWith("..") || path.posix.isAbsolute(dockerfile) || !isSafeRelativePath(dockerfile)) continue;
      const contextDir = relativeContext === "." ? context.root : path.join(context.root, relativeContext);
      if (!(await isNestedRegularFile(contextDir, dockerfile))) continue;
      built.push({ name, context: relativeContext, dockerfile, port: composePort(service.ports) ?? composePort(service.expose) });
    }
    return { file, built, images };
  }
  return null;
}

/** The container side of the first port mapping: "8080:3000" → 3000, "3000" → 3000, { target: 3000 } → 3000. */
function composePort(ports: unknown): number | null {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const first = ports[0] as unknown;
  const value = typeof first === "object" && first !== null ? (first as { target?: unknown }).target : String(first).split(":").pop()?.split("/")[0]?.split("-")[0];
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The single service a compose file builds, as a candidate using its Dockerfile. */
export async function composeCandidate(context: DetectContext, compose: { file: string; built: ComposeService[]; images: string[] }): Promise<Candidate | null> {
  if (compose.built.length !== 1) return null;
  const service = compose.built[0]!;
  const contextDir = service.context === "." ? context.root : path.join(context.root, service.context);
  const text = (await readNestedFile(contextDir, service.dockerfile, MAX_DOCKERFILE_BYTES)) ?? "";
  const exposed = parseExposedPort(text);
  const notes = ["Shipyard reads docker-compose for the Dockerfile and port only: set the service's variables and volumes in Shipyard."];
  if (compose.images.length > 0) {
    notes.push(`${compose.file} also runs ${compose.images.join(", ")}: add databases as Shipyard PostgreSQL services and pass their URLs as variables.`);
  }
  return {
    projectType: "docker",
    language: "Dockerfile",
    framework: null,
    runtime: null,
    packageManager: null,
    entrypoint: null,
    buildCommand: null,
    startCommand: context.overrides.startCommand ?? null,
    port: service.port ?? exposed ?? 3000,
    portSource: service.port ? `ports in ${compose.file}` : exposed ? "EXPOSE in the Dockerfile" : "assumed",
    confidence: 0.9,
    reasons: [`${compose.file} builds one service, "${service.name}", from ${joinRelative(service.context, service.dockerfile)}`],
    notes,
    contextDirectory: service.context,
    app: true,
    dockerfile: { kind: "repository", path: service.dockerfile, exposedPort: exposed },
  };
}
