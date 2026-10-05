import { describe, expect, it } from "vitest";

import { DeploymentStatus as PrismaDeploymentStatus } from "../../src/generated/prisma/enums.js";
import { ValidationError } from "../../src/lib/errors.js";
import { idParamsSchema, parseInput } from "../../src/lib/validation.js";
import { createProjectSchema } from "../../src/modules/projects/project.schemas.js";
import { DeploymentStatus } from "../../src/services/deployment/status.js";
import { parseSymrefHead } from "../../src/services/git/GitService.js";

describe("database enum", () => {
  it("Prisma's DeploymentStatus matches the state machine exactly", () => {
    expect(Object.values(PrismaDeploymentStatus).sort()).toEqual(Object.values(DeploymentStatus).sort());
  });
});

describe("parseInput", () => {
  it("returns typed data for valid input", () => {
    expect(parseInput(createProjectSchema, { repositoryUrl: " https://github.com/a/b " })).toEqual({
      repositoryUrl: "https://github.com/a/b",
    });
  });

  it("throws a ValidationError with per-field details", () => {
    try {
      parseInput(createProjectSchema, { name: "" }, "project");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe("Invalid project.");
      expect((error as ValidationError).details).toMatchObject({
        fieldErrors: { repositoryUrl: expect.any(Array), name: expect.any(Array) },
      });
    }
  });

  it("rejects non-UUID ids", () => {
    expect(() => parseInput(idParamsSchema, { id: "1; DROP TABLE projects" })).toThrow(ValidationError);
  });
});

describe("parseSymrefHead", () => {
  it("extracts the default branch", () => {
    const output = "ref: refs/heads/main\tHEAD\n7fd1a60b01f91b314f59955a4e4d4e80d8edf11d\tHEAD\n";
    expect(parseSymrefHead(output)).toBe("main");
  });

  it("handles branch names with slashes", () => {
    expect(parseSymrefHead("ref: refs/heads/release/v2\tHEAD\n")).toBe("release/v2");
  });

  it("returns null for unexpected output", () => {
    expect(parseSymrefHead("")).toBeNull();
    expect(parseSymrefHead("7fd1a60b\tHEAD\n")).toBeNull();
  });
});
