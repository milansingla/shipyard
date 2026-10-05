import { ValidationError } from "../../lib/errors.js";

export interface RepositoryRef {
  /** Normalized HTTPS clone URL, e.g. https://github.com/owner/repo.git */
  cloneUrl: string;
  host: string;
  owner: string;
  name: string;
}

const MAX_URL_LENGTH = 2048;
// GitHub's rules: alphanumerics and single hyphens, max 39 chars, no leading hyphen.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Validates an untrusted repository URL and returns a normalized reference.
 *
 * Only plain `https://<allowed-host>/<owner>/<repo>[.git]` is accepted. This rules
 * out file://, ssh://, git:// and ext:: transports (local file reads, arbitrary
 * command execution), embedded credentials, and argument-injection tricks such
 * as a URL starting with "-".
 */
export function parseRepositoryUrl(input: string, allowedHosts: readonly string[]): RepositoryRef {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new ValidationError("Repository URL is empty or too long.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError(`Invalid repository URL: ${raw}`);
  }

  if (url.protocol !== "https:") {
    throw new ValidationError("Repository URL must use https://");
  }
  if (url.username || url.password) {
    throw new ValidationError("Repository URL must not contain credentials.");
  }
  if (url.port !== "") {
    throw new ValidationError("Repository URL must not specify a port.");
  }
  if (url.search || url.hash) {
    throw new ValidationError("Repository URL must not contain a query string or fragment.");
  }

  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    throw new ValidationError(`Repository host "${host}" is not allowed. Allowed: ${allowedHosts.join(", ")}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new ValidationError("Repository URL must look like https://<host>/<owner>/<repo>");
  }

  const [owner, rawName] = segments as [string, string];
  const name = rawName.endsWith(".git") ? rawName.slice(0, -".git".length) : rawName;

  if (!isValidRepositoryOwner(owner)) {
    throw new ValidationError(`Invalid repository owner: ${owner}`);
  }
  if (!isValidRepositoryName(name)) {
    throw new ValidationError(`Invalid repository name: ${name}`);
  }

  return { cloneUrl: `https://${host}/${owner}/${name}.git`, host, owner, name };
}

export function isValidRepositoryOwner(owner: string): boolean {
  return OWNER_PATTERN.test(owner);
}

export function isValidRepositoryName(name: string): boolean {
  return REPO_PATTERN.test(name) && name !== "." && name !== "..";
}
