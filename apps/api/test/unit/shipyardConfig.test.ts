import { describe, expect, it } from "vitest";

import { mountPathSchema } from "../../src/modules/services/service.schemas.js";
import { parseShipyardConfig } from "../../src/services/config/shipyardConfig.js";

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
