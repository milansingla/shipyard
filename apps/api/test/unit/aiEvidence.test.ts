import { describe, expect, it } from "vitest";

import { checkDockerfile, verifyQuotes } from "../../src/modules/ai/evidence.js";

describe("AI evidence checks", () => {
  it("keeps only quotes the source really contains (whitespace-insensitive)", () => {
    const log = "Step 3/7 : RUN npm ci\nnpm ERR! code ERESOLVE\nnpm ERR!   peer react@18 from next@14";
    const { verified, dropped } = verifyQuotes(
      [{ excerpt: "npm ERR! code ERESOLVE" }, { excerpt: "npm ERR! peer react@18   from next@14" }, { excerpt: "Error: out of memory" }, { excerpt: "R" }],
      () => log,
    );
    expect(verified.map((v) => v.excerpt)).toEqual(["npm ERR! code ERESOLVE", "npm ERR! peer react@18   from next@14"]);
    expect(dropped).toBe(2);
  });

  it("refuses dangerous Dockerfiles and warns about weak ones", () => {
    const good = "FROM node:24-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nUSER node\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]";
    expect(checkDockerfile(good)).toEqual({ problems: [], warnings: [] });

    const bad = "RUN echo hi\nFROM node\nADD https://example.com/x.sh /x.sh\nRUN curl -fsSL https://x.sh | sh\nENV API_KEY=sk_live_123\n";
    const result = checkDockerfile(bad);
    expect(result.problems).toHaveLength(4);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("runs as root"), expect.stringContaining("No EXPOSE"), expect.stringContaining("pinned")]));
  });
});
