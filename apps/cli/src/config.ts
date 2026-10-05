import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface CliConfig {
  url: string;
  token: string;
}

/** ~/.shipyard/cli.json, readable only by you (it holds an API key). */
export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".shipyard", "cli.json");
}

/** SHIPYARD_URL + SHIPYARD_TOKEN (e.g. in CI) win over the saved login. */
export async function loadConfig(configPath: string, env: NodeJS.ProcessEnv): Promise<CliConfig | null> {
  if (env.SHIPYARD_URL && env.SHIPYARD_TOKEN) return { url: env.SHIPYARD_URL, token: env.SHIPYARD_TOKEN };
  try {
    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<CliConfig>;
    if (typeof saved.url === "string" && typeof saved.token === "string") return { url: saved.url, token: saved.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return null;
}

export async function saveConfig(configPath: string, config: CliConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  // Written to a temp file with 0600 first, so the key is never briefly world-readable.
  const temporary = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, configPath);
}

export async function removeConfig(configPath: string): Promise<void> {
  await fs.rm(configPath, { force: true });
}
