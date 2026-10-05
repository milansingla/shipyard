import { AppError, ErrorCode, errorMessage } from "../../lib/errors.js";
import type { Logger } from "../../lib/logger.js";
import { runCommand } from "../../lib/process.js";
import type { RepositoryRef } from "./repositoryUrl.js";

export interface CloneResult {
  path: string;
  commitSha: string;
}

/** What the deployment engine needs from a source provider. */
export interface SourceProvider {
  clone(repository: RepositoryRef, destination: string, branch: string | null): Promise<CloneResult>;
}

interface GitServiceOptions {
  cloneTimeoutMs: number;
}

// Hardening flags applied to every git invocation:
// - credential.helper=  : never use the host's stored git credentials (e.g. macOS keychain).
//                         Private repos will get proper token handling with GitHub OAuth.
// - core.symlinks=false : check symlinks out as plain files so a malicious repo cannot
//                         point Shipyard at files outside the workspace.
// - protocol.allow=never + https=always : no file://, ssh://, ext:: transports, even via redirects.
const GIT_HARDENING_ARGS = [
  "-c", "credential.helper=",
  "-c", "core.symlinks=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
] as const;

export class GitService implements SourceProvider {
  constructor(
    private readonly options: GitServiceOptions,
    private readonly logger: Logger,
  ) {}

  /**
   * Confirms the repository is reachable and returns a concrete branch name:
   * `branch` itself if it exists, or the repository's default branch when null.
   * Uses `git ls-remote`, which downloads refs only — no objects.
   */
  async resolveBranch(repository: RepositoryRef, branch: string | null): Promise<string> {
    const args =
      branch === null
        ? [...GIT_HARDENING_ARGS, "ls-remote", "--symref", "--", repository.cloneUrl, "HEAD"]
        : [...GIT_HARDENING_ARGS, "ls-remote", "--heads", "--", repository.cloneUrl, `refs/heads/${branch}`];

    let stdout: string;
    try {
      ({ stdout } = await runCommand("git", args, {
        timeoutMs: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }));
    } catch (error) {
      this.logger.warn({ err: error, repository: repository.cloneUrl }, "git ls-remote failed");
      throw new AppError(
        ErrorCode.GIT_CLONE_FAILED,
        `Can't read ${repository.cloneUrl}: ${explainGitFailure(errorMessage(error), { branch })}`,
        { statusCode: 422, cause: error },
      );
    }

    const resolved = branch === null ? parseSymrefHead(stdout) : stdout.trim() ? branch : null;
    if (resolved === null) {
      throw new AppError(
        ErrorCode.GIT_REF_NOT_FOUND,
        branch === null
          ? `Could not determine the default branch of ${repository.cloneUrl}.`
          : `Branch "${branch}" does not exist in ${repository.cloneUrl}.`,
        { statusCode: 422 },
      );
    }
    return resolved;
  }

  /**
   * Shallow-clones a single branch (or the default branch when `branch` is null).
   * `repository` and `branch` must already be validated by the caller.
   */
  async clone(repository: RepositoryRef, destination: string, branch: string | null): Promise<CloneResult> {
    const args = [...GIT_HARDENING_ARGS, "clone", "--depth", "1", "--single-branch", "--no-tags"];
    if (branch !== null) args.push("--branch", branch);
    // "--" ends option parsing: nothing after it can be interpreted as a flag.
    args.push("--", repository.cloneUrl, destination);

    this.logger.info({ repository: repository.cloneUrl, branch, destination }, "Cloning repository");

    try {
      await runCommand("git", args, {
        timeoutMs: this.options.cloneTimeoutMs,
        // Fail fast instead of hanging on an interactive username/password prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const { stdout } = await runCommand("git", ["-C", destination, "rev-parse", "HEAD"], {
        timeoutMs: 10_000,
      });
      return { path: destination, commitSha: stdout.trim() };
    } catch (error) {
      // Full git output (paths, flags) stays in the server log; users get the explanation.
      this.logger.warn({ err: error, repository: repository.cloneUrl, branch }, "git clone failed");
      throw new AppError(
        ErrorCode.GIT_CLONE_FAILED,
        `Could not clone ${repository.cloneUrl}${branch ? ` (branch ${branch})` : ""}: ${explainGitFailure(errorMessage(error), { branch, destination })}`,
        { statusCode: 422, cause: error },
      );
    }
  }
}

/**
 * Turns git's stderr into something a user can act on. Never returns server
 * paths: the workspace directory is replaced, and unrecognised output is
 * reduced to git's own `fatal:` line.
 */
export function explainGitFailure(raw: string, context: { branch?: string | null; destination?: string } = {}): string {
  // GitHub answers "not found" for private repositories too, and git then asks for a username.
  if (/could not read Username|Repository not found|Authentication failed|returned error: 40[134]/i.test(raw)) {
    return "the repository doesn't exist or is private. Shipyard can only clone public repositories for now.";
  }
  if (/Remote branch .* not found|couldn't find remote ref/i.test(raw)) {
    return `branch "${context.branch ?? "?"}" doesn't exist in the repository.`;
  }
  if (/timed out/i.test(raw)) return "git took too long and was stopped. Try again, or check the repository's size.";
  if (/Could not resolve host|unable to access/i.test(raw)) return "couldn't reach the git host from this server.";

  const fatal = raw.split("\n").find((line) => line.trim().startsWith("fatal:"))?.trim() ?? "git failed.";
  return context.destination ? fatal.split(context.destination).join("<workspace>") : fatal;
}

/**
 * Parses `git ls-remote --symref <url> HEAD`, whose first line looks like:
 *   ref: refs/heads/main<TAB>HEAD
 */
export function parseSymrefHead(output: string): string | null {
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(output);
  return match?.[1] ?? null;
}
