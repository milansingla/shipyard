import { ValidationError } from "../../lib/errors.js";

const MAX_BRANCH_LENGTH = 255;
const ALLOWED_CHARS = /^[A-Za-z0-9._/-]+$/;

/**
 * Conservative subset of git's ref-name rules (see `git check-ref-format`).
 * Rejects anything that could be parsed as a git option (leading "-").
 */
export function validateBranchName(input: string): string {
  const branch = input.trim();

  const invalid =
    branch.length === 0 ||
    branch.length > MAX_BRANCH_LENGTH ||
    !ALLOWED_CHARS.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.split("/").some((part) => part.startsWith("."));

  if (invalid) {
    throw new ValidationError(`Invalid branch name: ${input}`);
  }
  return branch;
}
