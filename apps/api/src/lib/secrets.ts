/**
 * Where secrets are protected: values are sealed bound to a context (e.g.
 * "env:<project>:<key>") so a sealed value copied elsewhere won't open.
 *
 * The local implementation is SecretBox (AES-256-GCM with SHIPYARD_SECRET_KEY,
 * see secretBox.ts). A provider backed by Vault or a cloud KMS would
 * implement the same two methods; nothing that stores secrets needs to change.
 */
export interface SecretProvider {
  encrypt(plaintext: string, context?: string): string;
  decrypt(sealed: string, context?: string): string;
}
