import { describe, expect, it } from "vitest";

import { ApiError, createApiClient } from "@/lib/api";

function client(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const api = createApiClient((async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as typeof fetch);
  return { api, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("API client", () => {
  it("calls /api on the same origin and unwraps { data }", async () => {
    const { api, calls } = client(() => json(200, { data: { id: 1 } }));
    expect(await api("/projects/1")).toEqual({ id: 1 });
    expect(calls[0]?.url).toBe("/api/projects/1");
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });

  it("sends JSON bodies", async () => {
    const { api, calls } = client(() => json(201, { data: {} }));
    await api("/projects", { method: "POST", body: { repositoryUrl: "x" } });
    expect(calls[0]?.init.body).toBe('{"repositoryUrl":"x"}');
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  it("returns undefined for 204", async () => {
    const { api } = client(() => new Response(null, { status: 204 }));
    expect(await api("/projects/1", { method: "DELETE" })).toBeUndefined();
  });

  it("surfaces the API's code and message", async () => {
    const { api } = client(() => json(409, { error: { code: "DEPLOYMENT_IN_PROGRESS", message: "Wait for it." } }));
    await expect(api("/x")).rejects.toMatchObject({ status: 409, code: "DEPLOYMENT_IN_PROGRESS", message: "Wait for it." });
  });

  it("adds the per-field reasons of a validation error to its message", async () => {
    const { api } = client(() =>
      json(400, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid variable name.",
          details: { formErrors: [], fieldErrors: { key: ["is set by Shipyard and can't be overridden"] } },
        },
      }),
    );
    await expect(api("/x")).rejects.toMatchObject({
      message: "Invalid variable name. key: is set by Shipyard and can't be overridden",
    });
  });

  it("flags 401 as signed out", async () => {
    const { api } = client(() => json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in." } }));
    const error = (await api("/x").catch((e: unknown) => e)) as ApiError;
    expect(error.isSignedOut).toBe(true);
  });

  it("explains a missing API (proxy error without JSON)", async () => {
    const { api } = client(() => new Response("Internal Server Error", { status: 500 }));
    await expect(api("/x")).rejects.toMatchObject({ code: "API_UNAVAILABLE" });
  });

  it("explains network failures", async () => {
    const { api } = client(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(api("/x")).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });
});
