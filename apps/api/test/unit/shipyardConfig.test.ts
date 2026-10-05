import { describe, expect, it } from "vitest";

import { connectionUrl, connectionVariable, postgresVersionOf } from "../../src/modules/services/postgres.js";
import { mountPathSchema } from "../../src/modules/services/service.schemas.js";
import { parseShipyardConfig, parseShipyardFile } from "../../src/services/config/shipyardConfig.js";

describe("shipyard.yaml", () => {
  it("maps services to Shipyard's settings, leaving out what the file doesn't set", () => {
    const services = parseShipyardConfig(`
version: 1
services:
  web:
    source: apps/web
    build:
      command: npm run build
    start:
      command: npm start
    port: 3000
    healthCheck:
      path: /healthz
    resources:
      cpu: 0.5
      memoryMb: 512
    volumes:
      uploads: /app/uploads
  api:
    source: apps/api
    port: 4000
    public: false
  jobs:
    type: worker
    source: apps/worker
    start:
      command: node worker.js
`);
    expect(services).toEqual([
      {
        name: "web",
        settings: {
          type: "WEB",
          sourceDir: "apps/web",
          buildCommand: "npm run build",
          startCommand: "npm start",
          port: 3000,
          healthCheckPath: "/healthz",
          cpuLimit: 0.5,
          memoryLimitMb: 512,
        },
        volumes: [{ name: "uploads", mountPath: "/app/uploads" }],
      },
      { name: "api", settings: { type: "WEB", sourceDir: "apps/api", port: 4000, public: false }, volumes: [] },
      { name: "jobs", settings: { type: "WORKER", sourceDir: "apps/worker", startCommand: "node worker.js" }, volumes: [] },
    ]);
  });

  it.each([
    ["version: 1\nservices:\n  web: [", "is not valid YAML"],
    ["version: 2\nservices:\n  web: {}", "at version"],
    ["version: 1\nservices:\n  web:\n    sorce: .", "at services.web"],
    ["version: 1\nservices:\n  Web_App: {}", "at services.Web_App"],
    ["version: 1\nservices:\n  web:\n    source: ../outside", "at services.web.source"],
    ["version: 1\nservices:\n  jobs:\n    type: worker\n    public: true", "workers can't be public"],
    ["version: 1\nservices:\n  web:\n    start:\n      command: \"a\\nb\"", "at services.web.start.command"],
    ["version: 1\nservices: {}", "at least one service"],
    ["version: 1\nservices:\n  web:\n    volumes:\n      data: relative/path", "at services.web.volumes.data"],
    ["version: 1\nservices:\n  web:\n    volumes:\n      data: /etc/app", "system directory"],
    ["version: 1\nservices:\n  web:\n    volumes:\n      a: /data\n      b: /data", "share a mount path"],
    ["version: 1\nservices:\n  db:\n    type: postgres\n    version: 12", "at services.db.version"],
    ["version: 1\nservices:\n  db:\n    type: postgres\n    port: 5433", "only takes version and resources"],
    ["version: 1\nservices:\n  db:\n    type: postgres\n    source: db", "only takes version and resources"],
    ["version: 1\nservices:\n  web:\n    version: 17", "only postgres services have a version"],
    ["version: 1\nservices:\n  web: {}\ncron:\n  nightly:\n    schedule: \"61 * * * *\"\n    command: x", "at cron.nightly.schedule"],
    ["version: 1\nservices:\n  web: {}\ncron:\n  nightly:\n    schedule: \"@daily\"\n    service: api\n    command: x", "\"api\" isn't a service in this file"],
    ["version: 1\nservices:\n  web: {}\n  db:\n    type: postgres\ncron:\n  vacuum:\n    schedule: \"@daily\"\n    service: db\n    command: x", "not a database's"],
  ])("explains what is wrong with %j", (source, message) => {
    expect(() => parseShipyardConfig(source)).toThrow(message);
  });

  it("refuses alias bombs (a few lines expanding into a huge document)", () => {
    const bomb = ["version: 1", "a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 0; i < 8; i += 1) bomb.push(`${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`);
    bomb.push("services:\n  web: {}");
    expect(() => parseShipyardConfig(bomb.join("\n"))).toThrow("shipyard.yaml");
  });
});

describe("volume mount paths", () => {
  it.each(["/data", "/app/uploads", "/var/lib/postgresql/data", "/home/node/.cache"])("accepts %s", (p) => {
    expect(mountPathSchema.safeParse(p).success).toBe(true);
  });

  it.each(["/", "data", "/app/../etc", "/app/./x", "/app//x", "/etc", "/etc/ssl", "/proc/self", "/usr/local", "/dev", "/app/x y", "/app\0"])(
    "refuses %j",
    (p) => {
      expect(mountPathSchema.safeParse(p).success).toBe(false);
    },
  );
});

describe("postgres services", () => {
  it("are declared with a version (default 17) and resources only", () => {
    const [db, analytics] = parseShipyardConfig("version: 1\nservices:\n  db:\n    type: postgres\n  analytics:\n    type: postgres\n    version: 16\n    resources:\n      memoryMb: 256\n");
    expect(db).toMatchObject({ name: "db", database: { version: 17 }, volumes: [] });
    expect(analytics).toMatchObject({ database: { version: 16 }, settings: { memoryLimitMb: 256 } });
  });

  it("names the URL variable DATABASE_URL first, then after the service", () => {
    expect(connectionVariable("db", new Set())).toBe("DATABASE_URL");
    expect(connectionVariable("analytics-db", new Set(["DATABASE_URL"]))).toBe("ANALYTICS_DB_DATABASE_URL");
    expect(connectionVariable("db", new Set(["DATABASE_URL", "DB_DATABASE_URL"]))).toBeNull();
  });

  it("builds the URL apps connect with, and reads versions only from Shipyard's own images", () => {
    expect(connectionUrl("db", "pw")).toBe("postgres://app:pw@db:5432/app");
    expect(postgresVersionOf("postgres:16-alpine")).toBe(16);
    expect(postgresVersionOf("postgres:9-alpine")).toBeNull();
    expect(postgresVersionOf("evil/postgres:17-alpine")).toBeNull();
  });
});

describe("cron jobs in shipyard.yaml", () => {
  it("default to the web service, and keep what the file says", () => {
    const { cron } = parseShipyardFile(
      'version: 1\nservices:\n  api: {}\n  web: {}\ncron:\n  cleanup:\n    schedule: "0 0 * * *"\n    command: npm run cleanup\n  report:\n    service: api\n    schedule: "@hourly"\n    command: node report.js\n    timeoutSeconds: 60\n',
    );
    expect(cron).toEqual([
      { name: "cleanup", service: "web", schedule: "0 0 * * *", command: "npm run cleanup" },
      { name: "report", service: "api", schedule: "@hourly", command: "node report.js", timeoutSeconds: 60 },
    ]);
  });
});
