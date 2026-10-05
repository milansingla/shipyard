import type { Request, Response } from "express";

export interface EventStream {
  /** Aborted when the client goes away or the stream reaches its maximum age. */
  readonly signal: AbortSignal;
  send(event: string, data: unknown): void;
  close(): void;
}

interface EventStreamOptions {
  /** Comment lines keep proxies from closing an idle connection. */
  heartbeatMs?: number;
  /** Long-lived connections are recycled; EventSource reconnects by itself. */
  maxDurationMs?: number;
}

/**
 * Server-Sent Events: one long HTTP response, `event:`/`data:` frames, and the
 * browser's EventSource reconnects automatically. One-way server → browser is
 * all log streaming needs, so no WebSocket server is required.
 */
export function openEventStream(_req: Request, res: Response, options: EventStreamOptions = {}): EventStream {
  const { heartbeatMs = 15_000, maxDurationMs = 60 * 60_000 } = options;
  const abort = new AbortController();

  res.status(200).set({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Tells nginx-style proxies not to buffer the response.
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
  const maxAge = setTimeout(() => close(), maxDurationMs);
  const close = () => {
    if (abort.signal.aborted) return;
    clearInterval(heartbeat);
    clearTimeout(maxAge);
    abort.abort();
    res.end();
  };
  // Not req.on("close"): for a GET that fires as soon as the (empty) request is read.
  res.on("close", close);

  return {
    signal: abort.signal,
    send(event, data) {
      if (abort.signal.aborted) return;
      // JSON on a single line: newlines inside log text can't break the framing.
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close,
  };
}
