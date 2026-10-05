import { execFile } from "node:child_process";

import { AppError, ErrorCode } from "./errors.js";

export interface RunCommandOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Max bytes buffered per stream before the process is killed. */
  maxBufferBytes?: number;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs a program with an argument ARRAY. No shell is involved, so untrusted
 * values (URLs, branch names) can never be interpreted as shell syntax.
 * Never replace this with exec() or `shell: true`.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes ?? 10 * 1024 * 1024,
        shell: false,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed && error.signal === "SIGTERM";
          const reason = timedOut
            ? `timed out after ${options.timeoutMs}ms`
            : stderr.trim() || error.message;
          reject(
            new AppError(ErrorCode.COMMAND_FAILED, `${command} ${args[0] ?? ""} failed: ${reason}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
