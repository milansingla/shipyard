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
      throw new AppError(
        ErrorCode.GIT_CLONE_FAILED,
        `Could not clone ${repository.cloneUrl}${branch ? ` (branch ${branch})` : ""}: ${errorMessage(error)}`,
        { statusCode: 422, cause: error },
      );
    }
  }
}
