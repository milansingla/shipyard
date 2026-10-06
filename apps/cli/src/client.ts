/** An API failure, with the server's stable error code and its human message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiClient {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Server-Sent Events: calls `onEvent` per frame until the stream ends. */
  stream(path: string, onEvent: (event: string, data: unknown) => void): Promise<void>;
}

/**
 * The CLI's only way to do anything: the Shipyard HTTP API, authenticated with
 * an API key. All deployment logic stays on the server.
 */
export function createClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/v1${path}`, {
        method,
        headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", `Can't reach Shipyard at ${base}. Is the URL right and the server running?`);
    }
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
      if (res.status === 401) throw new ApiError(401, "UNAUTHENTICATED", "Not signed in, or the API key was revoked. Run `shipyard login`.");
      throw new ApiError(res.status, payload?.error?.code ?? "UNKNOWN", withDetails(payload?.error?.message ?? `HTTP ${res.status}`, payload?.error?.details));
    }
    return res;
  }

  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await send(method, path, body);
      if (res.status === 204) return undefined as T;
      return ((await res.json()) as { data: T }).data;
    },

    async stream(path, onEvent) {
      const res = await send("GET", path);
      if (!res.body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const frame = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (frame) onEvent(frame.event, frame.data);
        }
      }
    },
  };
}

/** One SSE frame; comments (keep-alives) and incomplete frames are skipped. */
export function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return null;
  }
}

function withDetails(message: string, details: unknown): string {
  const fieldErrors = (details as { fieldErrors?: Record<string, string[] | undefined> } | undefined)?.fieldErrors ?? {};
  const reasons = Object.entries(fieldErrors).flatMap(([field, messages]) => (messages ?? []).map((m) => `${field}: ${m}`));
  return reasons.length ? `${message} ${reasons.join("; ")}` : message;
}
