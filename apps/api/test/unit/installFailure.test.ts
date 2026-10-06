import { describe, expect, it } from "vitest";

import { diagnoseInstallFailure } from "../../src/services/build/installFailure.js";
import type { InstallInfo } from "../../src/services/detection/types.js";

const pnpm: InstallInfo = {
  manager: "pnpm",
  version: "9",
  reason: "pnpm-lock.yaml (lockfileVersion 9.0) → pnpm 9",
  lockfile: "pnpm-lock.yaml",
  command: "pnpm install --frozen-lockfile",
  staleLockfile: ["firebase: package.json wants 10.7.1, the lockfile has latest"],
};

const dockerError = `Docker build failed: The command '/bin/sh -c echo "Using pnpm $(pnpm --version)" && pnpm install --frozen-lockfile' returned a non-zero code: 1`;

// The output of a real failed deployment (ANSI colour codes included, as Docker sends them).
const pnpmOutput = [
  'Step 8/21 : RUN echo "Using pnpm $(pnpm --version)" && pnpm install --frozen-lockfile',
  " ---> Running in a72c637fa025",
  "Using pnpm 9.15.9",
  "\u001b[0m\u001b[91mError: ERR_PNPM_OUTDATED_LOCKFILE",
  "",
  "  × installing dependencies",
  '\u001b[0m\u001b[91m  ╰─▶ Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up',
  "      to date with package.json.",
  "        - firebase (lockfile: latest, manifest: 10.7.1)",
  "\u001b[0m ---> Removed intermediate container a72c637fa025",
  `ERROR: ${"The command '/bin/sh -c echo \"Using pnpm $(pnpm --version)\" && pnpm install --frozen-lockfile' returned a non-zero code: 1"}`,
].join("\n");

describe("diagnoseInstallFailure", () => {
  it("an outdated pnpm lockfile: the version that ran, what is out of date, how to fix it, and pnpm's own words", () => {
    expect(diagnoseInstallFailure(pnpm, dockerError, `Step 7/21 : COPY . .\n${pnpmOutput}`)).toBe(
      [
        "Dependency installation failed: the lockfile is out of date with package.json.",
        "Package manager: pnpm 9.15.9 (pnpm-lock.yaml (lockfileVersion 9.0) → pnpm 9)",
        "Lockfile: pnpm-lock.yaml",
        "Command: pnpm install --frozen-lockfile",
        "Out of date:",
        "  - firebase: package.json wants 10.7.1, the lockfile has latest",
        "Fix: Run `pnpm install` locally and commit the updated pnpm-lock.yaml.",
        "pnpm said:",
        "  Error: ERR_PNPM_OUTDATED_LOCKFILE",
        "    × installing dependencies",
        '    ╰─▶ Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up',
        "        to date with package.json.",
        "          - firebase (lockfile: latest, manifest: 10.7.1)",
      ].join("\n"),
    );
  });

  it.each([
    ["npm ci out of sync", "npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.", "the lockfile is out of date"],
    ["yarn berry", "➤ YN0028: │ The lockfile would have been modified by this install, which is explicitly forbidden.", "the lockfile is out of date"],
    ["peer deps", "npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree", "peer dependencies conflict"],
    ["private package", "npm error code E401\nnpm error 401 Unauthorized - GET https://npm.pkg.github.com/@acme%2fsecret", "a package registry refused access"],
    ["engine", " ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)", "requires a different Node.js"],
    ["workspace", " ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  In apps/web: \"@acme/ui@workspace:*\" is in the dependencies but no package named \"@acme/ui\" is present in the workspace", "a workspace package it depends on is missing"],
    ["packageManager mismatch", " ERR_PNPM_BAD_PM_VERSION  This project is configured to use v8.15.9 of pnpm. Your current pnpm is v9.15.9", "doesn't match the package manager"],
    ["lockfile from another version", " ERR_PNPM_LOCKFILE_BREAKING_CHANGE  Lockfile /app/pnpm-lock.yaml not compatible with current pnpm", "written by a different version"],
  ])("%s", (_name, output, reason) => {
    const npm: InstallInfo = { manager: "npm", version: null, reason: "package-lock.json → npm", lockfile: "package-lock.json", command: "npm ci", staleLockfile: null };
    const install = output.includes("pnpm") ? pnpm : output.includes("YN0") ? { ...npm, manager: "yarn" as const, command: "yarn install --immutable" } : npm;
    const message = diagnoseInstallFailure(install, `The command '/bin/sh -c ${install.command}' returned a non-zero code: 1`, `RUN ${install.command}\n${output}\n`)!;
    expect(message.split("\n")[0]).toContain(reason);
    expect(message).not.toContain("Out of date:"); // only listed for an outdated lockfile
  });

  it("corepack's own line gives the version when the step didn't print one", () => {
    const message = diagnoseInstallFailure(pnpm, dockerError, "RUN pnpm install --frozen-lockfile\nInstalling pnpm@9.15.4...\n ERR_PNPM_OUTDATED_LOCKFILE  x\n")!;
    expect(message).toContain("Package manager: pnpm 9.15.4 (");
  });

  it("an install failure it can't classify still shows the command and the output", () => {
    const message = diagnoseInstallFailure({ ...pnpm, staleLockfile: null }, dockerError, "RUN pnpm install --frozen-lockfile\nsomething odd happened\n")!;
    expect(message.split("\n")[0]).toBe("Dependency installation failed.");
    expect(message).toContain("Package manager: pnpm 9 (");
    expect(message).toContain("  something odd happened");
  });

  it("downloading the package manager failed: a network problem on the server, said plainly", () => {
    const corepackError = `The command 'sh -c for attempt in $(seq 1 5); do corepack install --global pnpm@9 && exit 0; ...' returned a non-zero code: 1`;
    const output = [
      'Step 7/22 : RUN ["sh","-c","for attempt in $(seq 1 5); do corepack install --global pnpm@9 && exit 0; ..."]',
      "Internal Error: Error when performing the request to https://registry.npmjs.org/pnpm; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting",
      "Shipyard: couldn't download pnpm@9 (attempt 1 of 5); retrying in 3s",
      "Shipyard: couldn't download pnpm@9 from the npm registry after 5 attempts.",
    ].join("\n");
    const message = diagnoseInstallFailure({ ...pnpm, version: "9" }, corepackError, output)!;
    expect(message.split("\n").slice(0, 3)).toEqual([
      "Couldn't download pnpm@9 from the npm registry (registry.npmjs.org): the build had no working connection, even after retrying.",
      "This is a network problem on this server, not in your code.",
      "Fix: check this server's internet connection, DNS and proxy (Docker Desktop: Settings → Resources → Proxies), then redeploy.",
    ]);
    expect(message).toContain("Internal Error: Error when performing the request to https://registry.npmjs.org/pnpm");
  });

  it("not the install (the build step failed): null, the original error stands", () => {
    expect(diagnoseInstallFailure(pnpm, "The command '/bin/sh -c pnpm run build' returned a non-zero code: 1", pnpmOutput)).toBeNull();
  });
});
