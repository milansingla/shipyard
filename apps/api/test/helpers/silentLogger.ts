import { pino } from "pino";

import type { Logger } from "../../src/lib/logger.js";

export const silentLogger: Logger = pino({ level: "silent" });
