import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies GitHub's `X-Hub-Signature-256: sha256=<hex>` header: an HMAC-SHA256
 * of the exact request bytes, keyed with the webhook secret.
 *
 * - computed over the RAW body: re-serialized JSON would not match
 * - compared in constant time, so response timing can't leak the expected value
 */
export function verifyGitHubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signGitHubPayload(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
