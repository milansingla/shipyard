import semver from "semver";

import { argLines, assertPort, dockerignore, runShell, startCommand } from "./dockerfileParts.js";
import { isNestedRegularFile, isRegularFile, readNestedFile, readRegularFile } from "./files.js";
import { detectionError, truncate } from "./nodeProject.js";
import type { Candidate, DetectContext, ToolName, Unsupported } from "./types.js";

const MAX_BYTES = 256 * 1024;
/** Official python:<version>-slim images, newest first. */
export const PYTHON_VERSIONS = ["3.14", "3.13", "3.12", "3.11", "3.10", "3.9"] as const;
export const DEFAULT_PYTHON = "3.13";

/** Files an app's entry point is usually in, in the order they are tried. */
const ENTRY_FILES = [
  "main.py",
  "app.py",
  "server.py",
  "api.py",
  "application.py",
  "wsgi.py",
  "asgi.py",
  "streamlit_app.py",
  "Home.py",
  "app/main.py",
  "app/app.py",
  "app/__init__.py",
  "src/main.py",
  "src/app.py",
  "api/main.py",
  "api/index.py",
];

const MODULE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const VARIABLE = /^[A-Za-z_]\w*$/;

type Framework = "FastAPI" | "Flask" | "Django" | "Streamlit";

interface Installer {
  tool: ToolName;
  /** Copy only these before installing, so the install layer is cached; null = the whole source first. */
  dependencyFiles: string[] | null;
  commands: string[];
  reason: string;
}

/**
 * Python: an app is something with a web entry point (FastAPI, Flask,
 * Django, Streamlit, or a Procfile "web:" command). A package with none of
 * those is a library or a command-line tool, and is reported as such rather
 * than deployed as a web service that would never answer.
 */
export async function detectPython(context: DetectContext): Promise<Candidate | Unsupported | null> {
  const { dir } = context;
  const files = {
    requirements: await readRegularFile(dir, "requirements.txt", MAX_BYTES),
    pyproject: await readRegularFile(dir, "pyproject.toml", MAX_BYTES),
    pipfile: await readRegularFile(dir, "Pipfile", MAX_BYTES),
    setupPy: await isRegularFile(dir, "setup.py"),
    managePy: await readRegularFile(dir, "manage.py", MAX_BYTES),
  };
  const entries: Array<{ file: string; text: string }> = [];
  for (const file of ENTRY_FILES) {
    const text = await readNestedFile(dir, file, MAX_BYTES).catch(() => null);
    if (text !== null) entries.push({ file, text });
  }
  const hasManifest = files.requirements !== null || files.pyproject !== null || files.pipfile !== null || files.setupPy;
  if (!hasManifest && files.managePy === null && entries.length === 0) return null;

  const reasons: string[] = [];
  const notes: string[] = [];
  const manifests = [
    files.requirements !== null && "requirements.txt",
    files.pyproject !== null && "pyproject.toml",
    files.pipfile !== null && "Pipfile",
    files.setupPy && "setup.py",
  ].filter(Boolean);
  reasons.push(manifests.length > 0 ? `${manifests.join(", ")} found` : `Python source found (${entries.map((e) => e.file).join(", ") || "manage.py"})`);

  const declared = [files.requirements, files.pyproject, files.pipfile].filter((text): text is string => text !== null).join("\n").toLowerCase();
  const imports = entries.map((entry) => entry.text).join("\n");
  const depends = (name: string) => new RegExp(`(^|[^a-z0-9_.-])${name.replace(/[-_]/g, "[-_]")}([^a-z0-9_-]|$)`, "m").test(declared);
  const imported = (module: string) => new RegExp(`^\\s*(?:import\\s+${module}\\b|from\\s+${module}\\b)`, "m").test(imports);

  const version = pythonVersion(await readRegularFile(dir, ".python-version", 1024), await readRegularFile(dir, "runtime.txt", 1024), files.pyproject, files.pipfile, notes);
  const installer = await chooseInstaller(context, files.requirements, files.pyproject, files.pipfile, files.setupPy);
  if (installer) reasons.push(installer.reason);

  // What to run: a configured command, then a Procfile, then the framework's server.
  const procfile = await readRegularFile(dir, "Procfile", 64 * 1024);
  const procfileWeb = procfile ? /^web:\s*(.+)$/m.exec(procfile)?.[1]?.trim() : undefined;
  let framework: Framework | null = null;
  let command: string | null = null;
  let entrypoint: string | null = null;
  let port = 8000;
  let portSource = "Python default";
  const extras: string[] = [];

  if (files.managePy !== null || depends("django")) {
    framework = "Django";
    const settings = /DJANGO_SETTINGS_MODULE["']\s*,\s*["']([A-Za-z_][\w.]*)["']/.exec(files.managePy ?? "")?.[1];
    const project = settings?.replace(/\.settings(?:\.\w+)?$/, "");
    if (project && MODULE.test(project) && (await isNestedRegularFile(dir, `${project.replace(/\./g, "/")}/wsgi.py`))) {
      entrypoint = `${project}.wsgi:application`;
      command = `exec gunicorn ${entrypoint} --bind 0.0.0.0:\${PORT}`;
      reasons.push(`manage.py → Django project "${project}" (${project.replace(/\./g, "/")}/wsgi.py)`);
    } else if (!procfileWeb && !context.overrides.startCommand) {
      throw detectionError("This is a Django project, but Shipyard couldn't find its wsgi.py from manage.py's DJANGO_SETTINGS_MODULE. Set a start command (e.g. gunicorn mysite.wsgi --bind 0.0.0.0:$PORT).");
    }
    if (!depends("gunicorn")) extras.push("gunicorn");
    portSource = "Django (gunicorn) default";
  } else if (depends("fastapi") || imported("fastapi")) {
    framework = "FastAPI";
    const found = findApp(entries, /^([A-Za-z_]\w*)\s*(?::\s*[\w.]+\s*)?=\s*(?:fastapi\.)?FastAPI\s*\(/m);
    if (found) {
      entrypoint = `${found.module}:${found.variable}`;
      command = `exec uvicorn ${entrypoint} --host 0.0.0.0 --port \${PORT}`;
      reasons.push(`${found.file} creates the FastAPI app "${found.variable}"`);
    } else if (!procfileWeb && !context.overrides.startCommand) {
      throw detectionError(`FastAPI is a dependency, but no "app = FastAPI()" was found in ${ENTRY_FILES.slice(0, 5).join(", ")}, …. Set a start command (e.g. uvicorn package.module:app --host 0.0.0.0 --port $PORT).`);
    }
    if (!depends("uvicorn")) extras.push("uvicorn");
    portSource = "FastAPI (uvicorn) default";
  } else if (depends("flask") || imported("flask")) {
    framework = "Flask";
    const found =
      findApp(entries, /^([A-Za-z_]\w*)\s*(?::\s*[\w.]+\s*)?=\s*(?:flask\.)?Flask\s*\(/m) ??
      findApp(entries, /^def\s+(create_app)\s*\(/m, "()");
    if (found) {
      entrypoint = `${found.module}:${found.variable}`;
      command = `exec gunicorn '${entrypoint}' --bind 0.0.0.0:\${PORT}`;
      reasons.push(`${found.file} creates the Flask app "${found.variable}"`);
    } else if (!procfileWeb && !context.overrides.startCommand) {
      throw detectionError(`Flask is a dependency, but no "app = Flask(__name__)" or create_app() was found in ${ENTRY_FILES.slice(0, 5).join(", ")}, …. Set a start command.`);
    }
    if (!depends("gunicorn")) extras.push("gunicorn");
    port = 5000;
    portSource = "Flask default";
  } else if (depends("streamlit") || imported("streamlit")) {
    framework = "Streamlit";
    const found = entries.find((entry) => /^\s*(?:import\s+streamlit\b|from\s+streamlit\b)/m.test(entry.text));
    if (found) {
      entrypoint = found.file;
      command = `exec streamlit run ${found.file} --server.port=\${PORT} --server.address=0.0.0.0 --server.headless=true`;
      reasons.push(`${found.file} imports streamlit`);
    } else if (!procfileWeb && !context.overrides.startCommand) {
      throw detectionError("Streamlit is a dependency, but no file imports it (looked at streamlit_app.py, app.py, main.py, …). Set a start command.");
    }
    port = 8501;
    portSource = "Streamlit default";
  }
  if (framework && !hasManifest) extras.push(framework.toLowerCase());
  if (framework) reasons.unshift(`${framework} detected`);

  if (procfileWeb && !context.overrides.startCommand) {
    command = procfileWeb.slice(0, 1000);
    entrypoint = null;
    reasons.push(`Procfile web: ${truncate(procfileWeb, 60)}`);
    if (!framework) portSource = "Procfile (the app gets PORT)";
  }
  if (!command && !context.overrides.startCommand) {
    return {
      unsupported:
        `${context.rel === "." ? "The repository" : context.rel} is a Python project, but not a web app Shipyard can start: ` +
        "no FastAPI, Flask, Django or Streamlit app and no Procfile \"web:\" command. It looks like a library or command-line tool. " +
        "If it is a web service, set its start command.",
    };
  }

  if (/^\s*psycopg2(?!-binary)\b/m.test(declared) || /^\s*mysqlclient\b/m.test(declared)) {
    notes.push("Native database drivers (psycopg2 / mysqlclient) are compiled during the build; the -binary packages build faster.");
  }
  const needsCompiler = /(^|\n)\s*(psycopg2(?!-binary)|mysqlclient)\b/.test(declared);

  return {
    projectType: "python",
    language: "Python",
    runtime: `Python ${version}`,
    framework,
    packageManager: installer?.tool ?? "pip",
    entrypoint,
    buildCommand: [...(installer?.commands ?? []), ...extras.map((name) => `pip install ${name}`)].join(" && ") || null,
    startCommand: context.overrides.startCommand ?? command,
    port,
    portSource,
    confidence: framework ? 0.95 : 0.85,
    reasons,
    notes,
    contextDirectory: context.rel,
    app: true,
    dockerfile: {
      kind: "generated",
      dockerignore: dockerignore("__pycache__", "*.pyc", ".venv", "venv", ".pytest_cache", ".mypy_cache"),
      render: (input) =>
        renderPython({
          version,
          framework,
          installer,
          extras,
          needsCompiler,
          collectstatic: framework === "Django" && files.managePy !== null,
          command: command ?? "",
          ...input,
        }),
    },
  };
}

function findApp(entries: ReadonlyArray<{ file: string; text: string }>, pattern: RegExp, suffix = "") {
  for (const entry of entries) {
    const variable = pattern.exec(entry.text)?.[1];
    if (!variable || !VARIABLE.test(variable)) continue;
    const module = entry.file.replace(/\.py$/, "").replace(/\//g, ".").replace(/\.__init__$/, "");
    if (!MODULE.test(module)) continue;
    return { file: entry.file, module, variable: `${variable}${suffix}` };
  }
  return null;
}

async function chooseInstaller(context: DetectContext, requirements: string | null, pyproject: string | null, pipfile: string | null, setupPy: boolean): Promise<Installer | null> {
  const { dir } = context;
  if (await isRegularFile(dir, "uv.lock")) {
    return {
      tool: "uv",
      dependencyFiles: null,
      commands: [
        "pip install --no-cache-dir uv",
        "uv export --frozen --no-dev --no-hashes --no-emit-project -o /tmp/requirements.txt",
        "pip install --no-cache-dir -r /tmp/requirements.txt",
      ],
      reason: "uv.lock → installed with uv's locked versions",
    };
  }
  if (pyproject !== null && (await isRegularFile(dir, "poetry.lock"))) {
    return {
      tool: "poetry",
      dependencyFiles: null,
      commands: ["pip install --no-cache-dir poetry", "poetry config virtualenvs.create false", "poetry install --only main --no-root --no-interaction --no-ansi"],
      reason: "poetry.lock → installed with Poetry",
    };
  }
  if (pipfile !== null) {
    const locked = await isRegularFile(dir, "Pipfile.lock");
    return {
      tool: "pipenv",
      dependencyFiles: null,
      commands: ["pip install --no-cache-dir pipenv", locked ? "pipenv install --system --deploy" : "pipenv install --system --skip-lock"],
      reason: `Pipfile${locked ? " + Pipfile.lock" : ""} → installed with pipenv`,
    };
  }
  if (requirements !== null) {
    // `-r other.txt`, `-e .` and local paths need the rest of the source at install time.
    const local = /^\s*(-r|-c|-e|--requirement|--editable|\.|file:)/m.test(requirements);
    return {
      tool: "pip",
      dependencyFiles: local ? null : ["requirements.txt"],
      commands: ["pip install --no-cache-dir -r requirements.txt"],
      reason: "requirements.txt → installed with pip",
    };
  }
  if (pyproject !== null || setupPy) {
    return { tool: "pip", dependencyFiles: null, commands: ["pip install --no-cache-dir ."], reason: `${pyproject !== null ? "pyproject.toml" : "setup.py"} → installed with pip` };
  }
  return null;
}

/** The newest supported Python that the project's version files allow (default 3.13). */
export function pythonVersion(dotfile: string | null, runtime: string | null, pyproject: string | null, pipfile: string | null, notes: string[] = []): string {
  const exact =
    /^\s*(?:python-)?(3\.\d+)/.exec(dotfile ?? "")?.[1] ??
    /python-(3\.\d+)/.exec(runtime ?? "")?.[1] ??
    /python_version\s*=\s*["'](3\.\d+)/.exec(pipfile ?? "")?.[1];
  if (exact) {
    if ((PYTHON_VERSIONS as readonly string[]).includes(exact)) return exact;
    notes.push(`Python ${exact} isn't available as a generated image; using ${DEFAULT_PYTHON}.`);
    return DEFAULT_PYTHON;
  }
  const requires = /requires-python\s*=\s*["']([^"']+)["']/.exec(pyproject ?? "")?.[1];
  if (requires) {
    const range = requires.replace(/~=\s*(\d+\.\d+)/, "^$1").replace(/,/g, " ").replace(/==\s*(\d+\.\d+)\.\*/, "~$1");
    if (semver.validRange(range)) {
      const ordered = [DEFAULT_PYTHON, ...PYTHON_VERSIONS.filter((v) => v !== DEFAULT_PYTHON)];
      const match = ordered.find((v) => semver.satisfies(`${v}.0`, range) || semver.intersects(range, `~${v}.0`));
      if (match) return match;
    }
    notes.push(`requires-python "${truncate(requires, 40)}" couldn't be matched; using Python ${DEFAULT_PYTHON}.`);
  }
  return DEFAULT_PYTHON;
}

function renderPython(input: {
  version: string;
  framework: Framework | null;
  installer: Installer | null;
  extras: string[];
  needsCompiler: boolean;
  collectstatic: boolean;
  command: string;
  port: number;
  buildArgNames: readonly string[];
  buildCommand: string | null;
  startCommand: string | null;
}): string {
  const port = assertPort(input.port);
  const lines = [
    `# Generated by Shipyard for a ${input.framework ?? "Python"} app. To customise it, commit your own Dockerfile.`,
    `FROM python:${input.version}-slim`,
    "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_ROOT_USER_ACTION=ignore",
  ];
  if (input.needsCompiler) {
    lines.push(
      "RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libpq-dev default-libmysqlclient-dev && rm -rf /var/lib/apt/lists/*",
    );
  }
  lines.push("WORKDIR /app", ...argLines(input.buildArgNames));
  const installer = input.installer;
  if (installer?.dependencyFiles) {
    lines.push("# Dependencies first, so the install is cached until they change", `COPY ${installer.dependencyFiles.join(" ")} ./`, ...installer.commands.map((c) => `RUN ${c}`), "COPY . .");
  } else {
    lines.push("COPY . .", ...(installer?.commands ?? []).map((c) => `RUN ${c}`));
  }
  if (input.extras.length > 0) lines.push(`RUN pip install --no-cache-dir ${input.extras.map((name) => (/^[a-z][a-z0-9-]*$/.test(name) ? name : "")).join(" ")}`);
  if (input.buildCommand) lines.push(runShell(input.buildCommand));
  if (input.collectstatic) lines.push(`RUN ${JSON.stringify(["sh", "-c", "python manage.py collectstatic --noinput || echo 'collectstatic skipped (configure STATIC_ROOT to serve static files)'"])}`);
  lines.push(
    "# The app runs as an unprivileged user.",
    "RUN useradd --create-home --uid 10001 app && chown -R app:app /app",
    "USER app",
    `ENV PORT=${port}`,
    `EXPOSE ${port}`,
    startCommand(input.startCommand, ["sh", "-c", input.command]),
  );
  return `${lines.join("\n")}\n`;
}
