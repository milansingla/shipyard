const MAX_SLUG_LENGTH = 40;
const FALLBACK_SLUG = "app";

/**
 * Turns arbitrary text (e.g. a repository name) into a string that is valid
 * inside both Docker image names (lowercase only) and container names.
 */
export function toDockerSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || FALLBACK_SLUG;
}

/** First 12 hex chars of a UUID, like Docker's short container ids. */
export function shortId(deploymentId: string): string {
  return deploymentId.replace(/-/g, "").slice(0, 12).toLowerCase();
}

export function buildContainerName(repositoryName: string, deploymentId: string): string {
  return `shipyard-${toDockerSlug(repositoryName)}-${shortId(deploymentId)}`;
}

/** Docker's own container name/id rule. Used to validate user-supplied references. */
export function isValidContainerReference(reference: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(reference);
}
