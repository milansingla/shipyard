import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // the standard GCM nonce size
const TAG_BYTES = 16;
const VERSION = "v1";

/**
 * Encrypts small secrets (e.g. GitHub access tokens) before they are stored.
 *
 * AES-256-GCM from Node's crypto: authenticated encryption, so a modified
 * ciphertext fails to decrypt instead of decrypting to garbage. A fresh random
 * IV per encryption means the same token never produces the same ciphertext.
 *
 * Format: "v1:" + base64url(iv | tag | ciphertext). The version prefix lets the
 * scheme (or key) change later without guessing how old rows were written.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new RangeError(`SecretBox key must be ${KEY_BYTES} bytes, got ${key.length}.`);
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
  }

  /** Throws if the value was tampered with, encrypted with another key, or malformed. */
  decrypt(sealed: string): string {
    const [version, payload] = sealed.split(":");
    if (version !== VERSION || payload === undefined) throw new Error("Unsupported secret format.");

    const data = Buffer.from(payload, "base64url");
    if (data.length < IV_BYTES + TAG_BYTES) throw new Error("Secret is truncated.");

    const decipher = createDecipheriv(ALGORITHM, this.key, data.subarray(0, IV_BYTES));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  }
}

/** Parses SHIPYARD_SECRET_KEY: 32 random bytes, base64 (`openssl rand -base64 32`). */
export function parseSecretKey(value: string): Buffer | null {
  const key = Buffer.from(value, "base64");
  // Round-trip check rejects strings that aren't really base64.
  return key.length === KEY_BYTES && key.toString("base64") === value.trim() ? key : null;
}
