import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ErrorCode } from "../../src/lib/errors.js";
import { GENERATED_DOCKERFILE_NAME, prepareBuild } from "../../src/services/build/prepareBuild.js";
import { detectRepository } from "../../src/services/detection/RepositoryDetector.js";
import type { BuildOverrides } from "../../src/services/detection/types.js";

// Every repository here is a temporary directory written by the test: no network, no GitHub.

const created: string[] = [];
afterEach(async () => {
  for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipyard-detect-"));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

const json = (value: unknown) => JSON.stringify(value);

/** Detects and generates, like a deployment: returns the plan, the generated Dockerfile and the log. */
async function plan(dir: string, overrides: BuildOverrides = {}, serviceDir = dir) {
  let log = "";
  const result = await prepareBuild(serviceDir, (text) => void (log += text), [], overrides, { repositoryDir: dir });
  const dockerfile = await fs.readFile(path.join(result.contextDir, result.dockerfile), "utf8");
  return { ...result, dockerfileText: dockerfile, log };
}

async function failure(dir: string, overrides: BuildOverrides = {}, serviceDir = dir) {
  return (await prepareBuild(serviceDir, () => {}, [], overrides, { repositoryDir: dir }).catch((error: unknown) => error)) as { code: string; message: string };
}

describe("Node.js", () => {
  it("npm: an Express app, installed with npm ci, started by its start script", async () => {
    const dir = await repo({
      "package.json": json({ scripts: { start: "node server.js" }, dependencies: { express: "^5.0.0" } }),
      "package-lock.json": "{}",
      "server.js": "require('express')().listen(process.env.PORT || 3000)",
    });
    const result = await plan(dir);
    expect(result.detection).toMatchObject({ language: "Node.js", framework: "Express", packageManager: "npm", serviceDirectory: ".", port: 3000, dockerfile: "generated" });
    expect(result.dockerfileText).toContain("RUN npm ci");
    expect(result.dockerfileText).toContain('CMD ["npm","start"]');
    expect(result.log).toContain("Detected:");
    expect(result.log).toMatch(/Framework:\s+Express/);
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
  ])("%s → %s", async (lockfile, manager, install) => {
    const dir = await repo({ "package.json": json({ scripts: { start: "node index.js" } }), [lockfile]: "" });
    const result = await plan(dir);
    expect(result.detection.packageManager).toBe(manager);
    expect(result.dockerfileText).toContain(`RUN ${install}`);
    expect(result.dockerfileText).toContain("RUN corepack enable");
    expect(result.dockerfileText).not.toContain("npm ci");
  });

  it("bun: the Bun image, bun install --frozen-lockfile, bun start", async () => {
    const dir = await repo({ "package.json": json({ scripts: { start: "bun run server.ts" }, dependencies: { hono: "^4" } }), "bun.lock": "" });
    const result = await plan(dir);
    expect(result.detection).toMatchObject({ packageManager: "bun", framework: "Hono", runtime: "Bun 1" });
    expect(result.dockerfileText).toContain("FROM oven/bun:1-slim");
    expect(result.dockerfileText).toContain("RUN bun install --frozen-lockfile");
    expect(result.dockerfileText).toContain('CMD ["bun","start"]');
  });

  it("finds a port hard-coded in listen() when the app doesn't read PORT", async () => {
    const dir = await repo({ "package.json": json({ main: "app.js", dependencies: { express: "^4" } }), "app.js": "const app = require('express')();\napp.listen(8080);\n" });
    const result = await plan(dir);
    expect(result.detection).toMatchObject({ port: 8080, portSource: "listen(8080) in app.js" });
    expect(result.dockerfileText).toContain("EXPOSE 8080");
  });

  it("Next.js: its build and start scripts, port 3000; output: export → static files from out/", async () => {
    const server = await repo({ "package.json": json({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15", react: "19" } }), "package-lock.json": "{}" });
    const result = await plan(server);
    expect(result.detection).toMatchObject({ projectType: "nextjs", framework: "Next.js", buildCommand: "npm run build", startCommand: "npm start", port: 3000 });
    expect(result.dockerfileText).toContain("RUN npm run build");

    const exported = await repo({
      "package.json": json({ scripts: { build: "next build", dev: "next dev" }, dependencies: { next: "15" } }),
      "next.config.mjs": "export default { output: 'export' };",
    });
    const site = await plan(exported);
    expect(site.detection).toMatchObject({ projectType: "nextjs", port: 8080 });
    expect(site.dockerfileText).toContain("COPY --from=build /app/out /usr/share/nginx/html");
  });

  it("React + Vite: built with Node, served by nginx (no dev server in production)", async () => {
    const dir = await repo({
      "package.json": json({ scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { react: "19" }, devDependencies: { vite: "7" } }),
      "package-lock.json": "{}",
      "index.html": "<div id=root></div>",
    });
    const result = await plan(dir);
    expect(result.detection).toMatchObject({ projectType: "react", framework: "React + Vite", port: 8080, startCommand: "nginx" });
    expect(result.dockerfileText).toContain("FROM node:24-slim AS build");
    expect(result.dockerfileText).toContain("RUN npm run build");
    expect(result.dockerfileText).toContain("FROM nginxinc/nginx-unprivileged:1.27-alpine");
    expect(result.dockerfileText).toContain("COPY --from=build /app/dist /usr/share/nginx/html");
    expect(result.dockerfileText).toContain("try_files $uri $uri/ /index.html");
    expect(result.dockerfileText).toContain("location ~ /\\. { return 404; }");
    expect(result.dockerfileText).not.toContain("vite preview");
  });

  it("Vue + Vite with a custom outDir", async () => {
    const dir = await repo({
      "package.json": json({ scripts: { build: "vite build" }, dependencies: { vue: "3" }, devDependencies: { vite: "7" } }),
      "vite.config.ts": "export default { build: { outDir: 'public-build' } }",
    });
    const result = await plan(dir);
    expect(result.detection).toMatchObject({ projectType: "vite", framework: "Vue + Vite" });
    expect(result.dockerfileText).toContain("COPY --from=build /app/public-build /usr/share/nginx/html");
  });

  it("NestJS prefers start:prod; Nuxt runs its built server", async () => {
    const nest = await plan(await repo({ "package.json": json({ scripts: { build: "nest build", start: "nest start", "start:prod": "node dist/main" }, dependencies: { "@nestjs/core": "11" } }) }));
    expect(nest.detection).toMatchObject({ framework: "NestJS", startCommand: "npm run start:prod" });
    const nuxt = await plan(await repo({ "package.json": json({ scripts: { build: "nuxt build", dev: "nuxt dev" }, dependencies: { nuxt: "3" } }) }));
    expect(nuxt.dockerfileText).toContain('CMD ["node",".output/server/index.mjs"]');
    expect(nuxt.dockerfileText).toContain('ENV HOST="0.0.0.0"');
  });

  it("a SvelteKit app without a server or static adapter is explained, not guessed", async () => {
    const error = await failure(await repo({ "package.json": json({ scripts: { build: "vite build" }, devDependencies: { "@sveltejs/kit": "2", "@sveltejs/adapter-auto": "3", vite: "7" } }) }));
    expect(error.code).toBe(ErrorCode.PROJECT_DETECTION_FAILED);
    expect(error.message).toContain("adapter-node");
  });

  it("missing scripts: a package.json with nothing to start is a clear error", async () => {
    const error = await failure(await repo({ "package.json": json({ dependencies: { lodash: "4" } }) }));
    expect(error.code).toBe(ErrorCode.PROJECT_DETECTION_FAILED);
    expect(error.message).toContain('Add a "start" script');
  });
});

describe("Python", () => {
  it("FastAPI: uvicorn main:app on port 8000, uvicorn added when it isn't a dependency", async () => {
    const result = await plan(await repo({ "requirements.txt": "fastapi==0.115.0\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n" }));
    expect(result.detection).toMatchObject({ language: "Python", framework: "FastAPI", entrypoint: "main:app", port: 8000, packageManager: "pip" });
    expect(result.dockerfileText).toContain("FROM python:3.13-slim");
    expect(result.dockerfileText).toContain("COPY requirements.txt ./");
    expect(result.dockerfileText).toContain("RUN pip install --no-cache-dir uvicorn");
    expect(result.dockerfileText).toContain("exec uvicorn main:app --host 0.0.0.0 --port ${PORT}");
    expect(result.dockerfileText).toContain("USER app");
  });

  it("Flask: gunicorn on port 5000, with the Python version from .python-version", async () => {
    const result = await plan(await repo({ "requirements.txt": "Flask\ngunicorn\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n", ".python-version": "3.12\n" }));
    expect(result.detection).toMatchObject({ framework: "Flask", entrypoint: "app:app", port: 5000, runtime: "Python 3.12" });
    expect(result.dockerfileText).toContain("exec gunicorn 'app:app' --bind 0.0.0.0:${PORT}");
    expect(result.dockerfileText).not.toContain("pip install --no-cache-dir gunicorn");
  });

  it("Django: gunicorn <project>.wsgi:application, found from manage.py", async () => {
    const result = await plan(
      await repo({
        "requirements.txt": "Django>=5\n",
        "manage.py": "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n",
        "mysite/wsgi.py": "application = get_wsgi_application()\n",
        "mysite/settings.py": "",
      }),
    );
    expect(result.detection).toMatchObject({ framework: "Django", entrypoint: "mysite.wsgi:application", port: 8000 });
    expect(result.dockerfileText).toContain("exec gunicorn mysite.wsgi:application --bind 0.0.0.0:${PORT}");
  });

  it("Streamlit and Poetry", async () => {
    const result = await plan(await repo({ "pyproject.toml": '[tool.poetry.dependencies]\nstreamlit = "^1.40"\n', "poetry.lock": "", "streamlit_app.py": "import streamlit as st\n" }));
    expect(result.detection).toMatchObject({ framework: "Streamlit", packageManager: "poetry", port: 8501 });
    expect(result.dockerfileText).toContain("poetry install --only main --no-root");
  });

  it("a library or CLI is reported as one, not deployed as a web service", async () => {
    const error = await failure(await repo({ "pyproject.toml": '[project]\nname = "mytool"\ndependencies = ["click"]\n', "mytool/__init__.py": "" }));
    expect(error.code).toBe(ErrorCode.DOCKERFILE_NOT_FOUND);
    expect(error.message).toContain("library or command-line tool");
  });
});

describe("PHP, Go, Java, Rust, static", () => {
  it("plain PHP: Apache serving the directory", async () => {
    const result = await plan(await repo({ "index.php": "<?php echo 'hi';" }));
    expect(result.detection).toMatchObject({ language: "PHP", framework: null, port: 8080 });
    expect(result.dockerfileText).toContain("FROM php:8.3-apache");
    expect(result.dockerfileText).not.toContain("APACHE_DOCUMENT_ROOT");
  });

  it("Laravel: served from public/, composer install without dev dependencies", async () => {
    const result = await plan(await repo({ "composer.json": json({ require: { php: "^8.2", "laravel/framework": "^11.0" } }), artisan: "", "public/index.php": "<?php" }));
    expect(result.detection).toMatchObject({ framework: "Laravel", packageManager: "composer" });
    expect(result.dockerfileText).toContain("ENV APACHE_DOCUMENT_ROOT=/var/www/html/public");
    expect(result.dockerfileText).toContain("composer install --no-dev --optimize-autoloader");
    expect(result.detection.notes.join(" ")).toContain("APP_KEY");
  });

  it("Go: compiled in golang, run from distroless; the one cmd/<name> is the main package", async () => {
    const result = await plan(await repo({ "go.mod": "module example.com/shop\n\ngo 1.22\n", "go.sum": "", "cmd/server/main.go": 'package main\nfunc main() { http.ListenAndServe(":9000", nil) }\n' }));
    expect(result.detection).toMatchObject({ language: "Go", entrypoint: "./cmd/server", port: 9000, runtime: "Go 1.22" });
    expect(result.dockerfileText).toContain("FROM golang:1.22 AS build");
    expect(result.dockerfileText).toContain("go build -trimpath");
    expect(result.dockerfileText).toContain("./cmd/server");
    expect(result.dockerfileText).toContain("FROM gcr.io/distroless/static-debian12:nonroot");
  });

  it("Go with several commands and no clear service asks instead of guessing", async () => {
    const error = await failure(await repo({ "go.mod": "module x\n\ngo 1.23\n", "cmd/migrate/main.go": "package main", "cmd/seed/main.go": "package main" }));
    expect(error.message).toContain("cmd/migrate, cmd/seed");
  });

  it("Spring Boot (Maven): Java version from the pom, server.port from application.properties", async () => {
    const result = await plan(
      await repo({
        "pom.xml": "<project><properties><java.version>17</java.version></properties><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>",
        "src/main/resources/application.properties": "server.port=8081\n",
        "src/main/java/App.java": "",
      }),
    );
    expect(result.detection).toMatchObject({ framework: "Spring Boot", packageManager: "maven", port: 8081, runtime: "Java 17" });
    expect(result.dockerfileText).toContain("FROM maven:3.9-eclipse-temurin-17 AS build");
    expect(result.dockerfileText).toContain("FROM eclipse-temurin:17-jre");
    expect(result.dockerfileText).toContain("SERVER_PORT=8081");
  });

  it("Rust (Axum): built with cargo, the binary run on Debian slim as a non-root user", async () => {
    const result = await plan(await repo({ "Cargo.toml": '[package]\nname = "shop-api"\nversion = "0.1.0"\n\n[dependencies]\naxum = "0.8"\n', "Cargo.lock": "", "src/main.rs": 'let addr = "0.0.0.0:3000";' }));
    expect(result.detection).toMatchObject({ language: "Rust", framework: "Axum", entrypoint: "shop-api", port: 3000 });
    expect(result.dockerfileText).toContain("RUN cargo build --release --locked --bin shop-api");
    expect(result.dockerfileText).toContain("COPY --from=build /src/target/release/shop-api /usr/local/bin/shop-api");
  });

  it("plain HTML: nginx serving the files, dotfiles never served", async () => {
    const result = await plan(await repo({ "index.html": "<h1>hi</h1>", "style.css": "" }));
    expect(result.detection).toMatchObject({ projectType: "static", port: 8080 });
    expect(result.dockerfileText).toContain("COPY . /usr/share/nginx/html");
    expect(result.dockerfileText).toContain("location ~ /\\. { return 404; }");
  });
});

describe("Dockerfiles", () => {
  it("uses the repository's Dockerfile and generates nothing", async () => {
    const dir = await repo({ Dockerfile: "FROM node:24\nEXPOSE 4000\n", "package.json": json({ scripts: { start: "x" } }) });
    const result = await plan(dir);
    expect(result).toMatchObject({ source: "repository", dockerfile: "Dockerfile", containerPort: 4000 });
    expect(await fs.readdir(dir)).not.toContain(GENERATED_DOCKERFILE_NAME);
  });

  it("picks the production variant among Dockerfile.* files", async () => {
    const result = await plan(await repo({ "Dockerfile.dev": "FROM node\n", "Dockerfile.prod": "FROM node\nEXPOSE 8000\n" }));
    expect(result).toMatchObject({ dockerfile: "Dockerfile.prod", containerPort: 8000 });
  });

  it("builds a monorepo app's own Dockerfile from the root when its COPY paths are relative to the root", async () => {
    const dir = await repo({ "apps/web/Dockerfile": "FROM node\nCOPY packages ./packages\nCOPY apps/web ./apps/web\n", "packages/ui/index.js": "" });
    const result = await plan(dir, {}, path.join(dir, "apps/web"));
    expect(result.detection).toMatchObject({ serviceDirectory: "apps/web", contextDirectory: ".", dockerfilePath: "apps/web/Dockerfile" });
    expect(result.contextDir).toBe(await fs.realpath(dir));
  });

  it("docker-compose: uses the Dockerfile of the one service it builds, and its container port", async () => {
    const dir = await repo({
      "docker-compose.yml": "services:\n  app:\n    build:\n      context: ./backend\n      dockerfile: Dockerfile.prod\n    ports: ['8080:5000']\n  db:\n    image: postgres:16\n",
      "backend/Dockerfile.prod": "FROM python:3.13\n",
    });
    const result = await plan(dir);
    expect(result.detection).toMatchObject({ contextDirectory: "backend", dockerfilePath: "Dockerfile.prod", port: 5000 });
    expect(result.detection.notes.join(" ")).toContain("db (postgres:16)");
  });
});

describe("monorepos and service directories", () => {
  it("finds the one app in a pnpm workspace and builds it from the workspace root", async () => {
    const dir = await repo({
      "package.json": json({ private: true, scripts: { build: "turbo build" } }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
      "pnpm-lock.yaml": "",
      "apps/web/package.json": json({ name: "web", scripts: { build: "next build", start: "next start" }, dependencies: { next: "15", ui: "workspace:*" } }),
      "packages/ui/package.json": json({ name: "ui", main: "index.js" }),
    });
    const result = await plan(dir);
    expect(result.detection).toMatchObject({ serviceDirectory: "apps/web", contextDirectory: ".", framework: "Next.js", packageManager: "pnpm" });
    expect(result.detection.reasons[0]).toContain("the only service found is in apps/web");
    expect(result.dockerfileText).toContain("RUN pnpm install --frozen-lockfile");
    expect(result.dockerfileText).toContain('RUN ["pnpm","--filter","web...","run","build"]');
    expect(result.dockerfileText).toContain("WORKDIR /app/apps/web");
    // Generated files go into the build context (the clone), nowhere else.
    expect(await fs.readdir(dir)).toContain(GENERATED_DOCKERFILE_NAME);
    expect(await fs.readdir(path.join(dir, "apps/web"))).not.toContain(GENERATED_DOCKERFILE_NAME);
  });

  it("uses an explicit service directory as given", async () => {
    const dir = await repo({ "backend/requirements.txt": "flask\n", "backend/app.py": "from flask import Flask\napp = Flask(__name__)\n", "frontend/index.html": "" });
    const result = await plan(dir, {}, path.join(dir, "backend"));
    expect(result.detection).toMatchObject({ serviceDirectory: "backend", framework: "Flask" });
  });

  it("several apps: names them and says how to choose, instead of deploying the wrong one", async () => {
    const error = await failure(
      await repo({
        "frontend/package.json": json({ scripts: { build: "vite build" }, devDependencies: { vite: "7" } }),
        "backend/requirements.txt": "fastapi\n",
        "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      }),
    );
    expect(error.code).toBe(ErrorCode.PROJECT_DETECTION_FAILED);
    expect(error.message).toContain("Found 2 deployable services");
    expect(error.message).toContain("  - backend: FastAPI (Python)");
    expect(error.message).toContain("  - frontend: Vite (Node.js)");
    expect(error.message).toContain("      source: backend");
  });

  it("nothing deployable: says what was checked and what was found", async () => {
    const empty = await failure(await repo({ "README.md": "# notes" }));
    expect(empty.code).toBe(ErrorCode.DOCKERFILE_NOT_FOUND);
    expect(empty.message).toContain("No supported application detected.");
    expect(empty.message).toContain("Go (go.mod), Java (pom.xml, build.gradle), Rust (Cargo.toml)");
    expect(empty.message).not.toContain("No Dockerfile or package.json found");

    const ruby = await failure(await repo({ Gemfile: "gem 'rails'" }));
    expect(ruby.message).toContain("Ruby (Gemfile)");
  });

  it("a configured port wins over detection", async () => {
    const result = await plan(await repo({ "requirements.txt": "fastapi\n", "main.py": "app = FastAPI()\n" }), { port: 9000 });
    expect(result.detection).toMatchObject({ port: 9000, portSource: "configured for the service" });
    expect(result.dockerfileText).toContain("EXPOSE 9000");
    expect(result.containerPort).toBe(9000);
  });
});

describe("untrusted repository content", () => {
  it("never follows a symlinked service directory out of the repository", async () => {
    const outside = await repo({ "package.json": json({ scripts: { start: "node x.js" } }) });
    const dir = await repo({ "README.md": "" });
    await fs.mkdir(path.join(dir, "apps"));
    await fs.symlink(outside, path.join(dir, "apps/web"));
    const error = await failure(dir);
    expect(error.code).toBe(ErrorCode.DOCKERFILE_NOT_FOUND);
  });

  it("refuses a service directory outside the repository", async () => {
    const outside = await repo({ "index.html": "" });
    const dir = await repo({ "README.md": "" });
    await expect(detectRepository({ root: dir, serviceDir: outside })).rejects.toThrow("outside the repository");
  });

  it("ignores paths in repository files that would leave the repository", async () => {
    const compose = await failure(await repo({ "docker-compose.yml": "services:\n  app:\n    build: ../../etc\n" }));
    expect(compose.code).toBe(ErrorCode.DOCKERFILE_NOT_FOUND);

    const vite = await plan(await repo({ "package.json": json({ scripts: { build: "vite build" }, devDependencies: { vite: "7" } }), "vite.config.js": "export default { build: { outDir: '../../etc' } }" }));
    expect(vite.dockerfileText).toContain("COPY --from=build /app/dist ");

    const main = await failure(await repo({ "package.json": json({ main: "../../etc/passwd" }) }));
    expect(main.message).toContain("not a safe relative path");
  });

  it("keeps repository values out of Dockerfile syntax: a malicious Procfile command stays one exec argument", async () => {
    const result = await plan(await repo({ "requirements.txt": "flask\n", "app.py": "app = Flask(__name__)\n", Procfile: 'web: gunicorn app:app\nRUN echo "pwned"' }));
    const cmdLine = result.dockerfileText.split("\n").find((line) => line.startsWith("CMD "))!;
    expect(JSON.parse(cmdLine.slice(4))).toEqual(["sh", "-c", "gunicorn app:app"]);
    expect(result.dockerfileText).not.toContain('RUN echo "pwned"');
  });
});
