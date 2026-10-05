import { shortId, toDockerSlug } from "../docker/naming.js";

/**
 * Where deployment images live. The engine asks it what to call an image
 * before building, and to publish it after.
 *
 * - LocalRegistry: images stay in this host's Docker (development, one server).
 * - RemoteRegistry: images are pushed to a registry (GHCR, Docker Hub, a
 *   private one), so other machines can pull them later.
 */
export interface ImageRegistry {
  /** Full image reference for a deployment, e.g. ghcr.io/acme/shop:3f2a9c1e77b4. */
  imageName(name: string, deploymentId: string): string;
  /** Makes a freshly built image available from the registry. */
  publish(imageName: string, onLog: (text: string) => void): Promise<void>;
}

export class LocalRegistry implements ImageRegistry {
  imageName(name: string, deploymentId: string): string {
    return `shipyard/${toDockerSlug(name)}:${shortId(deploymentId)}`;
  }

  async publish(): Promise<void> {}
}

export interface RegistryCredentials {
  username: string;
  password: string;
}

/** What RemoteRegistry needs from Docker. */
export interface ImagePusher {
  pushImage(imageName: string, credentials: RegistryCredentials | null, onLog: (text: string) => void): Promise<void>;
}

/**
 * A registry such as ghcr.io/acme or registry.example.com:5000/shipyard. The
 * prefix is validated at startup (see config); credentials are optional (a
 * registry on localhost usually needs none) and are never logged.
 */
export class RemoteRegistry implements ImageRegistry {
  constructor(
    private readonly prefix: string,
    private readonly credentials: RegistryCredentials | null,
    private readonly docker: ImagePusher,
  ) {}

  imageName(name: string, deploymentId: string): string {
    return `${this.prefix}/${toDockerSlug(name)}:${shortId(deploymentId)}`;
  }

  async publish(imageName: string, onLog: (text: string) => void): Promise<void> {
    onLog(`Pushing ${imageName}\n`);
    await this.docker.pushImage(imageName, this.credentials, onLog);
    onLog(`Pushed ${imageName}\n`);
  }
}
