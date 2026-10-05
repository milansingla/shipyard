import { describe, expect, it } from "vitest";

import { SecretBox, parseSecretKey } from "../../src/lib/secretBox.js";

const box = new SecretBox(Buffer.alloc(32, 1));

describe("SecretBox", () => {
  it("round-trips, with a different ciphertext every time", () => {
    const a = box.encrypt("gho_secret");
    const b = box.encrypt("gho_secret");
    expect(a).not.toBe(b);
    expect(a).not.toContain("gho_secret");
    expect(a.startsWith("v1:")).toBe(true);
    expect(box.decrypt(a)).toBe("gho_secret");
  });

  it("detects tampering", () => {
    const sealed = box.encrypt("gho_secret");
    const bytes = Buffer.from(sealed.slice(3), "base64url");
    bytes[bytes.length - 1]! ^= 1;
    expect(() => box.decrypt(`v1:${bytes.toString("base64url")}`)).toThrow();
  });

  it("refuses a value encrypted with another key", () => {
    const other = new SecretBox(Buffer.alloc(32, 2));
    expect(() => box.decrypt(other.encrypt("gho_secret"))).toThrow();
  });

  it.each(["", "gho_plaintext", "v2:abc", "v1:", "v1:AAAA"])("rejects malformed %j", (value) => {
    expect(() => box.decrypt(value)).toThrow();
  });

  it("requires a 32-byte key", () => {
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow(RangeError);
  });
});

describe("parseSecretKey", () => {
  it("accepts 32 bytes of base64", () => {
    expect(parseSecretKey(Buffer.alloc(32, 9).toString("base64"))?.length).toBe(32);
  });
  it.each(["", "short", Buffer.alloc(16).toString("base64"), "!".repeat(44)])("rejects %j", (value) => {
    expect(parseSecretKey(value)).toBeNull();
  });
});
