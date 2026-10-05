import { pino, type Logger } from "pino";

import type { LogLevel } from "../config/env.js";

export type { Logger };

interface LoggerOptions {
  level: LogLevel;
  /** Human-readable output for local development. Production always logs JSON. */
  pretty: boolean;
}

export function createLogger({ level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    redact: ["req.headers.authorization", "req.headers.cookie", "*.token", "*.accessToken"],
    ...(pretty && {
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      },
    }),
  });
}
