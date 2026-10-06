import { parseArgs } from "node:util";

import { ApiError, type ApiClient, createClient } from "./client.js";
import { type CliConfig, defaultConfigPath, loadConfig, removeConfig, saveConfig } from "./config.js";

interface Project {
  id: string;
  name: string;
  slug: string;
  role: string;
  organization: { name: string; personal: boolean };
  latestDeployment: Deployment | null;
}

interface Deployment {
  id: string;
  status: string;
  commitSha: string | null;
  deploymentUrl: string | null;
  errorMessage: string | null;
  failedStage: string | null;
  createdAt: string;
}

interface Service {
  id: string;
  name: string;
  type: "WEB" | "WORKER";
  public: boolean;
  port: number | null;
  latestDeployment: Deployment | null;
}

interface EnvVar {
  key: string;
  value: string | null;
  secret: boolean;
  target: string;
}

export interface Io {
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Reads one line (the API key at `shipyard login`). */
  readLine: () => Promise<string>;
  configPath?: string;
  fetch?: typeof fetch;
}

export const USAGE = `shipyard — deploy and manage apps on your Shipyard server

  shipyard login --url <dashboard-url> [--token <api-key>]
  shipyard logout
  shipyard projects
  shipyard status   <project>
  shipyard deploy   <project> [--no-follow]
  shipyard logs     <project> [--build] [--follow] [--tail <n>]
  shipyard rollback <project>
  shipyard env      <project>                                   list variables
  shipyard env      <project> set KEY=value [--secret] [--build | --both]
  shipyard env      <project> unset KEY
  shipyard domains  <project>                                   list custom domains
  shipyard domains  <project> add <hostname>                    route a domain to it (point its DNS here)
  shipyard domains  <project> remove <hostname>

<project> is a project's name, slug or id. Create an API key in the dashboard
(API keys). SHIPYARD_URL and SHIPYARD_TOKEN override the saved login (CI).
`;

/** Runs one command; returns the process exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      follow: { type: "boolean", short: "f" },
      "no-follow": { type: "boolean" },
      build: { type: "boolean" },
      both: { type: "boolean" },
      secret: { type: "boolean" },
      tail: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  const configPath = io.configPath ?? defaultConfigPath();

  try {
    if (!command || values.help || command === "help") {
      io.stdout(USAGE);
      return 0;
    }
    if (command === "login") return await login(values.url, values.token, configPath, io);
    if (command === "logout") {
      await removeConfig(configPath);
      io.stdout("Signed out. (The API key itself still works until you revoke it in the dashboard.)\n");
      return 0;
    }

    const config = await loadConfig(configPath, io.env);
    if (!config) {
      io.stderr("Not signed in. Run `shipyard login --url <dashboard-url>` first.\n");
      return 1;
    }
    const api = createClient(config.url, config.token, io.fetch);
    const project = async () => resolveProject(api, args[0]);

    switch (command) {
      case "projects":
        return await listProjects(api, io);
      case "status":
        return await status(api, await project(), io);
      case "deploy":
        return await deploy(api, await project(), !values["no-follow"], io);
      case "logs":
        return await logs(api, await project(), { build: Boolean(values.build), follow: Boolean(values.follow), tail: values.tail }, io);
      case "rollback":
        return await rollback(api, await project(), io);
      case "domains":
        return await domains(api, await project(), args.slice(1), io);
      case "env":
        return await env(api, await project(), args.slice(1), { secret: Boolean(values.secret), build: Boolean(values.build), both: Boolean(values.both) }, io);
      default:
        io.stderr(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.stderr(`${error instanceof ApiError || error instanceof UsageError ? error.message : String(error)}\n`);
    return 1;
  }
}

class UsageError extends Error {}

async function login(url: string | undefined, token: string | undefined, configPath: string, io: Io): Promise<number> {
  if (!url) throw new UsageError("Usage: shipyard login --url <dashboard-url> [--token <api-key>]");
  let key = token;
  if (!key) {
    io.stdout("Paste an API key (dashboard → API keys): ");
    key = (await io.readLine()).trim();
  }
  if (!/^shp_[A-Za-z0-9_-]{43}$/.test(key)) throw new UsageError("That doesn't look like a Shipyard API key (shp_…).");
  const config: CliConfig = { url: url.replace(/\/+$/, ""), token: key };
  const me = await createClient(config.url, config.token, io.fetch).request<{ login: string }>("GET", "/auth/me");
  await saveConfig(configPath, config);
  io.stdout(`Signed in to ${config.url} as ${me.login}.\n`);
  return 0;
}

async function resolveProject(api: ApiClient, reference: string | undefined): Promise<Project> {
  if (!reference) throw new UsageError("Which project? Give its name, slug or id. `shipyard projects` lists them.");
  const projects = await api.request<Project[]>("GET", "/projects");
  const wanted = reference.toLowerCase();
  const project = projects.find((p) => p.id === reference || p.slug === wanted || p.name.toLowerCase() === wanted);
  if (!project) throw new UsageError(`No project "${reference}". \`shipyard projects\` lists yours.`);
  return project;
}

async function listProjects(api: ApiClient, io: Io): Promise<number> {
  const projects = await api.request<Project[]>("GET", "/projects");
  if (projects.length === 0) {
    io.stdout("No projects yet. Create one in the dashboard.\n");
    return 0;
  }
  io.stdout(
    table(
      ["NAME", "TEAM", "STATUS", "URL"],
      projects.map((p) => [
        p.slug,
        p.organization.personal ? "—" : p.organization.name,
        p.latestDeployment?.status ?? "never deployed",
        p.latestDeployment?.status === "RUNNING" ? (p.latestDeployment.deploymentUrl ?? "") : "",
      ]),
    ),
  );
  return 0;
}

async function status(api: ApiClient, project: Project, io: Io): Promise<number> {
  const deployments = await api.request<Deployment[]>("GET", `/projects/${project.id}/deployments?limit=5`);
  const services = await api.request<Service[]>("GET", `/projects/${project.id}/services`);
  const live = deployments.find((d) => d.status === "RUNNING" && d.deploymentUrl);
  io.stdout(`${project.name}  (${project.organization.personal ? "personal" : project.organization.name}, you are ${project.role.toLowerCase()})\n`);
  io.stdout(live ? `Live at ${live.deploymentUrl} — deployment ${short(live.id)}, commit ${short(live.commitSha)}\n\n` : "Nothing running.\n\n");
  if (services.length > 1) {
    io.stdout(
      table(
        ["SERVICE", "TYPE", "STATUS", "ADDRESS"],
        services.map((s) => [
          s.name,
          s.type === "WORKER" ? "worker" : s.public ? "web" : "web (private)",
          s.latestDeployment?.status ?? "never deployed",
          s.latestDeployment?.deploymentUrl ?? (s.type === "WEB" && !s.public ? `http://${s.name}:${s.port ?? "<port>"} (inside the project)` : ""),
        ]),
      ),
    );
    io.stdout("\n");
  }
  if (deployments.length > 0) {
    io.stdout(table(["DEPLOYMENT", "STATUS", "COMMIT", "CREATED"], deployments.map((d) => [short(d.id), d.status, short(d.commitSha), new Date(d.createdAt).toLocaleString()])));
  }
  return 0;
}

/** Deploys the latest commit and, by default, streams the build until it is live or failed. */
async function deploy(api: ApiClient, project: Project, follow: boolean, io: Io): Promise<number> {
  const deployment = await api.request<Deployment>("POST", `/projects/${project.id}/deploy`);
  io.stdout(`Deploying ${project.name} — deployment ${short(deployment.id)}\n`);
  if (!follow) return 0;
  await api.stream(`/deployments/${deployment.id}/logs/stream?type=build`, (event, data) => {
    if (event === "log") io.stdout((data as { text: string }).text);
  });
  return reportOutcome(api, deployment.id, io);
}

async function reportOutcome(api: ApiClient, deploymentId: string, io: Io): Promise<number> {
  // The build log ends a moment before the final status is written: wait for it.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const deployment = await api.request<Deployment>("GET", `/deployments/${deploymentId}`);
    if (deployment.status === "RUNNING") {
      io.stdout(`\nLive at ${deployment.deploymentUrl}\n`);
      return 0;
    }
    if (deployment.status === "FAILED") {
      io.stderr(`\nDeployment failed${deployment.failedStage ? ` while ${deployment.failedStage}` : ""}: ${deployment.errorMessage}\n`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  io.stderr("\nStill in progress. Check with `shipyard status`.\n");
  return 1;
}

async function logs(api: ApiClient, project: Project, options: { build: boolean; follow: boolean; tail?: string }, io: Io): Promise<number> {
  const deployments = await api.request<Deployment[]>("GET", `/projects/${project.id}/deployments?limit=20`);
  const target = deployments.find((d) => d.status === "RUNNING") ?? deployments[0];
  if (!target) throw new UsageError(`${project.name} has no deployments yet.`);
  const type = options.build ? "build" : "runtime";
  const tail = options.tail ? `&tail=${Number.parseInt(options.tail, 10) || 200}` : "";
  if (options.follow) {
    await api.stream(`/deployments/${target.id}/logs/stream?type=${type}${tail}`, (event, data) => {
      const payload = data as { text?: string; message?: string };
      if (event === "log" && payload.text) io.stdout(payload.text);
      if (event === "end" && payload.message) io.stderr(`${payload.message}\n`);
    });
    return 0;
  }
  const result = await api.request<{ content: string; message?: string }>("GET", `/deployments/${target.id}/logs?type=${type}${tail}`);
  if (result.message) io.stderr(`${result.message}\n`);
  io.stdout(result.content);
  return 0;
}

async function rollback(api: ApiClient, project: Project, io: Io): Promise<number> {
  const deployments = await api.request<Deployment[]>("GET", `/projects/${project.id}/deployments?limit=20`);
  const current = deployments.find((d) => d.status === "RUNNING") ?? deployments[0];
  if (!current) throw new UsageError(`${project.name} has no deployments to roll back.`);
  io.stdout(`Rolling back ${project.name} from deployment ${short(current.id)}…\n`);
  const restored = await api.request<Deployment>("POST", `/deployments/${current.id}/rollback`);
  io.stdout(`Deployment ${short(restored.id)} is live again at ${restored.deploymentUrl}\n`);
  return 0;
}

async function env(
  api: ApiClient,
  project: Project,
  args: string[],
  flags: { secret: boolean; build: boolean; both: boolean },
  io: Io,
): Promise<number> {
  const [action = "list", argument] = args;
  if (action === "list") {
    const vars = await api.request<EnvVar[]>("GET", `/projects/${project.id}/env`);
    if (vars.length === 0) io.stdout("No variables.\n");
    else io.stdout(table(["NAME", "VALUE", "AVAILABLE AT"], vars.map((v) => [v.key, v.secret ? "(secret)" : (v.value ?? "(hidden)"), v.target.toLowerCase()])));
    return 0;
  }
  if (action === "set") {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(argument ?? "");
    if (!match) throw new UsageError("Usage: shipyard env <project> set KEY=value [--secret] [--build | --both]");
    const target = flags.both ? "BOTH" : flags.build ? "BUILD" : "RUNTIME";
    await api.request("PUT", `/projects/${project.id}/env/${match[1]}`, { value: match[2], secret: flags.secret, target });
    io.stdout(`Set ${match[1]}${flags.secret ? " (secret)" : ""}. It applies on the next deploy.\n`);
    return 0;
  }
  if (action === "unset" && argument) {
    await api.request("DELETE", `/projects/${project.id}/env/${encodeURIComponent(argument)}`);
    io.stdout(`Removed ${argument}. It applies on the next deploy.\n`);
    return 0;
  }
  throw new UsageError("Usage: shipyard env <project> [list | set KEY=value | unset KEY]");
}

async function domains(api: ApiClient, project: Project, args: string[], io: Io): Promise<number> {
  const [action = "list", hostname] = args;
  if (action === "list") {
    const list = await api.request<Array<{ hostname: string }>>("GET", `/projects/${project.id}/domains`);
    io.stdout(list.length === 0 ? "No custom domains.\n" : `${list.map((domain) => domain.hostname).join("\n")}\n`);
    return 0;
  }
  if (action === "add" && hostname) {
    await api.request("POST", `/projects/${project.id}/domains`, { hostname });
    io.stdout(`${hostname} routes to ${project.name} now. Point its DNS (A/AAAA or CNAME) at this server.\n`);
    return 0;
  }
  if (action === "remove" && hostname) {
    await api.request("DELETE", `/projects/${project.id}/domains/${encodeURIComponent(hostname)}`);
    io.stdout(`Removed ${hostname}.\n`);
    return 0;
  }
  throw new UsageError("Usage: shipyard domains <project> [list | add <hostname> | remove <hostname>]");
}

function short(id: string | null): string {
  return id ? id.replace(/-/g, "").slice(0, 7) : "—";
}

/** Plain aligned columns: readable in a terminal and easy to grep. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd();
  return `${[line(headers), ...rows.map(line)].join("\n")}\n`;
}
