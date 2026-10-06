import { describe, expect, it } from "vitest";

import { UrlGuard, WebhookProvider, isPrivateAddress } from "../../src/services/notify/NotificationProvider.js";

describe("notification URL guard (SSRF)", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])(
    "%s is private",
    (address) => {
      expect(isPrivateAddress(address)).toBe(true);
    },
  );

  it.each(["8.8.8.8", "172.32.0.1", "2606:4700::1111"])("%s is public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("wants https, no credentials, and public hosts", async () => {
    const guard = new UrlGuard(false);
    expect(() => guard.parse("http://hooks.example.com/x")).toThrow("https");
    expect(() => guard.parse("https://user:pw@hooks.example.com/x")).toThrow("credentials");
    expect(() => guard.parse("not a url")).toThrow("valid URL");
    await expect(guard.check("https://127.0.0.1/hook")).rejects.toThrow("private network");
    await expect(guard.check("https://169.254.169.254/latest/meta-data")).rejects.toThrow("private network");
    await expect(guard.check("https://localhost/hook")).rejects.toThrow("private network");
  });

  it("checks the address again when connecting, so DNS rebinding can't slip past the first check", async () => {
    // As if the host had resolved publicly for check() and privately for the request.
    const guard = new UrlGuard(false);
    guard.check = async () => {};
    const notification = { kind: "TEST", severity: "WARNING", status: "OPEN", title: "t", message: "m", project: null, url: null, at: "" } as const;
    await expect(new WebhookProvider(guard).send("https://localhost:9/hook", notification)).rejects.toThrow("private network");
  });

  it("can be relaxed for local development", async () => {
    await expect(new UrlGuard(true).check("http://127.0.0.1:9999/hook")).resolves.toBeUndefined();
  });
});
