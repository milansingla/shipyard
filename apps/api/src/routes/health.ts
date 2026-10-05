import { Router } from "express";

import { sendData } from "../lib/http.js";
import type { DockerService } from "../services/docker/DockerService.js";

export interface HealthResponse {
  status: "ok" | "degraded";
  docker: "reachable" | "unreachable";
}

/** GET /api/health — is the API up, and can it reach the Docker daemon? */
export function createHealthRouter(docker: Pick<DockerService, "ping">): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const dockerReachable = await docker.ping();
    const body: HealthResponse = {
      status: dockerReachable ? "ok" : "degraded",
      docker: dockerReachable ? "reachable" : "unreachable",
    };
    sendData(res, body, dockerReachable ? 200 : 503);
  });

  return router;
}
