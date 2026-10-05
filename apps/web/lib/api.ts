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
      | { data?: T; error?: { code?: string; message?: string } }
      | null;

    if (!res.ok) {
      // The dashboard's proxy answers 500/502 with no JSON when the API process is down.
      if (!body?.error) {
        throw new ApiError(res.status, "API_UNAVAILABLE", "The Shipyard API isn't responding. Is it running (npm run dev:api)?");
      }
      throw new ApiError(res.status, body.error.code ?? "UNKNOWN", body.error.message ?? `Request failed (HTTP ${res.status}).`);
    }
    return body?.data as T;
  };
}

export const api = createApiClient();
