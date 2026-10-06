import { describe, expect, it } from "vitest";

import { containerName, readTunnelLog } from "../../src/services/tunnel/CloudflareTunnel.js";

// Lines as cloudflared 2026.10 prints them.
const assigned = [
  "2026-10-06T19:50:01Z INF Requesting new quick Tunnel on trycloudflare.com...",
  "2026-10-06T19:50:04Z INF +--------------------------------------------------------------------------------------------+",
  "2026-10-06T19:50:04Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  "2026-10-06T19:50:04Z INF |  https://spot-precisely-millions-develops.trycloudflare.com                                 |",
  "2026-10-06T19:50:04Z INF +--------------------------------------------------------------------------------------------+",
].join("\n");
const registered = "2026-10-06T19:50:07Z INF Registered tunnel connection connIndex=0 location=del06 protocol=quic";

describe("readTunnelLog", () => {
  it("starting: the address is assigned but no connection to Cloudflare yet", () => {
    expect(readTunnelLog(assigned, true)).toEqual({ state: "starting", url: "https://spot-precisely-millions-develops.trycloudflare.com", detail: null });
    expect(readTunnelLog("2026-10-06T19:50:01Z INF Requesting new quick Tunnel on trycloudflare.com...", true)).toEqual({ state: "starting", url: null, detail: null });
  });

  it("live once a connection registers after the address", () => {
    expect(readTunnelLog(`${assigned}\n${registered}`, true)).toEqual({ state: "live", url: "https://spot-precisely-millions-develops.trycloudflare.com", detail: null });
  });

  it("after a restart, the newest address counts, and it isn't live until it reconnects", () => {
    const restarted = `${assigned}\n${registered}\n${assigned.replace("spot-precisely-millions-develops", "calm-river-ocean-lamp")}`;
    expect(readTunnelLog(restarted, true)).toEqual({ state: "starting", url: "https://calm-river-ocean-lamp.trycloudflare.com", detail: null });
    expect(readTunnelLog(`${restarted}\n${registered}`, true).state).toBe("live");
  });

  it("failed: the container stopped, with cloudflared's last errors", () => {
    const log = `${assigned}\n2026-10-06T19:51:00Z ERR Failed to dial a quic connection error="timeout: no recent network activity"`;
    expect(readTunnelLog(log, false)).toEqual({ state: "failed", url: null, detail: 'ERR Failed to dial a quic connection error="timeout: no recent network activity"' });
    expect(readTunnelLog("", false)).toEqual({ state: "failed", url: null, detail: "The tunnel stopped." });
  });
});

describe("containerName", () => {
  it("is stable per project and a valid Docker name", () => {
    expect(containerName("6595e930-b9a5-471d-a4cb-6d3602ba408e")).toBe("shipyard-tunnel-6595e930b9a5");
  });
});
