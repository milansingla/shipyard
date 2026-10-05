/** An API failure, carrying the API's stable error code (see apps/api/src/lib/errors.ts). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isSignedOut(): boolean {
    return this.status === 401;
  }
}

export type ApiClient = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/**
 * Calls the Shipyard API on this origin (`/api/...`, proxied by Next.js) and
 * unwraps `{ data }`. Failures become ApiError with the API's message, which is
 * written for people and shown as-is.
 */
export function createApiClient(fetchImpl: typeof fetch = (...args) => fetch(...args)): ApiClient {
  return async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`/api${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(init.body !== undefined && { "content-type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "Can't reach Shipyard. Check your connection and try again.");
    }

    if (res.status === 204) return undefined as T;

    const body = (await res.json().catch(() => null)) as
      | { data?: T; error?: { code?: string; message?: string; details?: unknown } }
      | null;

    if (!res.ok) {
      // The dashboard's proxy answers 500/502 with no JSON when the API process is down.
      if (!body?.error) {
        throw new ApiError(res.status, "API_UNAVAILABLE", "The Shipyard API isn't responding. Is it running (npm run dev:api)?");
      }
      const message = body.error.message ?? `Request failed (HTTP ${res.status}).`;
      throw new ApiError(res.status, body.error.code ?? "UNKNOWN", withValidationDetails(message, body.error.details));
    }
    return body?.data as T;
  };
}

export const api = createApiClient();

/**
 * The API reports validation failures as a summary ("Invalid environment
 * variable.") plus per-field messages (zod's flattened errors). The person
 * needs the reasons, so they are appended: "… key: is set by Shipyard".
 */
function withValidationDetails(message: string, details: unknown): string {
  const { formErrors = [], fieldErrors = {} } = (details ?? {}) as {
    formErrors?: string[];
    fieldErrors?: Record<string, string[] | undefined>;
  };
  const reasons = [
    ...formErrors,
    ...Object.entries(fieldErrors).flatMap(([field, messages]) => (messages ?? []).map((m) => `${field}: ${m}`)),
  ];
  return reasons.length === 0 ? message : `${message} ${reasons.join("; ")}`;
}
