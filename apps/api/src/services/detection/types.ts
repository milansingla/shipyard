/** What kind of project a directory holds, as shown to the user. */
export type ProjectType =
  | "node"
  | "nextjs"
  | "react"
  | "vite"
  | "static"
  | "python"
  | "php"
  | "java"
  | "go"
  | "rust"
  | "docker"
  | "unknown";

export type ToolName =
  | "npm"
  | "yarn"
  | "pnpm"
  | "bun"
  | "pip"
  | "poetry"
  | "uv"
  | "pipenv"
  | "composer"
  | "go"
  | "maven"
  | "gradle"
  | "cargo";

/** What a service configures instead of detecting it (shipyard.yaml or the dashboard). */
export interface BuildOverrides {
  buildCommand?: string | null;
  startCommand?: string | null;
  port?: number | null;
}

/**
 * Shipyard's conclusion about how to build and run a service: written to the
 * build log so a failure can be understood from what was detected.
 */
export interface DetectionResult {
  projectType: ProjectType;
  /** "Node.js", "Python", …, or "Dockerfile" when the repository brings its own. */
  language: string;
  framework: string | null;
  /** Language runtime of the generated image ("Node 24", "Python 3.13"), or null. */
  runtime: string | null;
  packageManager: ToolName | null;
  /** The service's directory, relative to the repository root ("." = the root). */
  serviceDirectory: string;
  /** The Docker build context, relative to the repository root (a workspace root may be above the service). */
  contextDirectory: string;
  /** Dockerfile used, relative to the build context. */
  dockerfilePath: string;
  dockerfile: "repository" | "generated";
  entrypoint: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number;
  /** Where the port came from ("EXPOSE in the Dockerfile", "Flask default", …). */
  portSource: string;
  /** 0–1: how sure detection is. */
  confidence: number;
  /** Evidence for each decision. */
  reasons: string[];
  /** Warnings and advice worth showing. */
  notes: string[];
}

/** Inputs a generated Dockerfile depends on beyond detection. */
export interface RenderInput {
  port: number;
  /** Build variable names, declared as ARGs (values are passed to `docker build`, never written). */
  buildArgNames: readonly string[];
  buildCommand: string | null;
  startCommand: string | null;
}

/** One way to build a directory, found by a language detector. */
export interface Candidate {
  projectType: ProjectType;
  language: string;
  framework: string | null;
  runtime: string | null;
  packageManager: ToolName | null;
  entrypoint: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number;
  portSource: string;
  confidence: number;
  reasons: string[];
  notes: string[];
  /** Build context relative to the repository root. */
  contextDirectory: string;
  dockerfile:
    | { kind: "repository"; path: string; exposedPort: number | null }
    | { kind: "generated"; render: (input: RenderInput) => string; dockerignore: string };
  /**
   * An application (serves HTTP or runs as a process), not a library. Only
   * applications are picked when Shipyard looks for the service in subdirectories.
   */
  app: boolean;
}

/** A directory that is recognisably some kind of project, but not one Shipyard can run. */
export interface Unsupported {
  unsupported: string;
}

/** What a detector looks at. */
export interface DetectContext {
  /** Repository root (absolute, real path). */
  root: string;
  /** The directory being examined (absolute). */
  dir: string;
  /** `dir` relative to the root, POSIX ("." = the root). */
  rel: string;
  overrides: BuildOverrides;
}

export type Detector = (context: DetectContext) => Promise<Candidate | Unsupported | null>;

export function isUnsupported(value: Candidate | Unsupported | null): value is Unsupported {
  return value !== null && "unsupported" in value;
}

/** Joins POSIX paths relative to the repository root, keeping "." for the root. */
export function joinRelative(...parts: string[]): string {
  const joined = parts.filter((part) => part !== "." && part !== "").join("/");
  return joined === "" ? "." : joined;
}
