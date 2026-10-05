import { describe, expect, it } from "vitest";

import { healthCheckPathSchema, updateProjectSchema } from "../../src/modules/projects/project.schemas.js";

describe("project settings", () => {
  it.each(["/", "/healthz", "/api/health?deep=1", "/status/ready"])("accepts the health path %j", (path) => {
    expect(healthCheckPathSchema.parse(path)).toBe(path);
  });

  it.each(["", "health", "//evil.example/", "http://evil.example/", "/a b", "/a\\\\b", "/#frag", "/\u0000"])(
    "rejects the health path %j",
    (path) => {
      expect(healthCheckPathSchema.safeParse(path).success).toBe(false);
    },
  );

  it("accepts null to reset the port and timeout to their defaults", () => {
    expect(updateProjectSchema.parse({ healthCheckPort: null, healthCheckTimeoutSeconds: null })).toEqual({
      healthCheckPort: null,
      healthCheckTimeoutSeconds: null,
    });
  });

  it.each([{}, { healthCheckPort: 0 }, { healthCheckTimeoutSeconds: 1 }, { healthCheckTimeoutSeconds: 3600 }, { name: "x" }])(
    "rejects %j",
    (input) => {
      expect(updateProjectSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe("resource limits", () => {
  it.each([0.1, 0.15, 0.25, 0.5, 1, 2.5, 64])("accepts %d CPUs", (cpuLimit) => {
    expect(updateProjectSchema.parse({ cpuLimit })).toEqual({ cpuLimit });
  });

  it.each([
    { cpuLimit: 0.05 },
    { cpuLimit: 0.123 },
    { cpuLimit: 65 },
    { memoryLimitMb: 32 },
    { memoryLimitMb: 512.5 },
    { restartPolicy: "ALWAYS" },
  ])("rejects %j", (input) => {
    expect(updateProjectSchema.safeParse(input).success).toBe(false);
  });

  it("accepts null to remove a limit", () => {
    expect(updateProjectSchema.parse({ cpuLimit: null, memoryLimitMb: null, restartPolicy: "NO" })).toEqual({
      cpuLimit: null,
      memoryLimitMb: null,
      restartPolicy: "NO",
    });
  });
});
