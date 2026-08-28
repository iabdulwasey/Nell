/**
 * Authenticated encryption for vault secrets.
 *
 * AES-256-GCM with:
 * - a fresh random 96-bit IV per write (never reused),
 * - additional authenticated data binding each ciphertext to
 *   `workspaceId | namespace | itemId`, so a ciphertext cannot be moved between
 *   items, namespaces, or tenants — a database-level attacker who swaps rows
 *   gets an auth-tag failure, not another tenant's secret,
 * - a key id in the wire format, so keys can be rotated without a flag day.
 *
 * Wire format (all segments base64url, dot-separated):
 *   v2.<keyId>.<iv>.<authTag>.<ciphertext>
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { Secret } from "./secret.js";

const FORMAT_VERSION = "v2";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Identifies which data-encryption key produced a ciphertext. */
export type KeyId = string;

/** A single data-encryption key with its identifier. */
export interface VaultKey {
  readonly id: KeyId;
  readonly material: Buffer;
}

/** Binds a ciphertext to exactly one logical slot. */
export interface SecretBinding {
  readonly workspaceId: string;
  readonly namespace: string;
  readonly itemId: string;
}

/**
 * Resolves key material by id. In self-host this is backed by a master key from
 * the environment; in the hosted tier by per-tenant data-encryption keys
 * unwrapped through a KMS-held key-encryption key.
 */
export interface KeyProvider {
  /** The key new writes should use. */
  active(): Promise<VaultKey>;
  /** Look up a key by id so older ciphertexts stay readable during rotation. */
  byId(id: KeyId): Promise<VaultKey | undefined>;
}

export function assertKeyMaterial(material: Buffer): Buffer {
  if (material.length !== KEY_BYTES) {
    throw new Error(
      `Vault key must be exactly ${String(KEY_BYTES)} bytes (got ${String(material.length)}).`
    );
  }
  return material;
}

/** Decode a base64 key, validating length. */
export function keyFromBase64(id: KeyId, encoded: string): VaultKey {
  const material = Buffer.from(encoded, "base64");
  return { id, material: assertKeyMaterial(material) };
}

/**
 * The AAD. Null-separated so no two distinct bindings can produce the same
 * byte string (a separator that cannot appear in the components).
 */
function additionalData(binding: SecretBinding): Buffer {
  return Buffer.from(
    `${binding.workspaceId}\u0000${binding.namespace}\u0000${binding.itemId}`,
    "utf8"
  );
}

function encodeSegment(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** Key ids travel in the wire format, so they must not contain the separator. */
function assertKeyId(id: KeyId): KeyId {
  if (!id || id.includes(".")) {
    throw new Error("Vault key id must be non-empty and contain no '.'.");
  }
  return id;
}

export async function encryptSecret(
  keys: KeyProvider,
  binding: SecretBinding,
  plaintext: Secret<string> | string
): Promise<string> {
  const key = await keys.active();
  assertKeyId(key.id);
  assertKeyMaterial(key.material);

  const value = plaintext instanceof Secret ? plaintext.expose() : plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.material, iv);
  cipher.setAAD(additionalData(binding));

  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return [
    FORMAT_VERSION,
    key.id,
    encodeSegment(iv),
    encodeSegment(cipher.getAuthTag()),
    encodeSegment(ciphertext),
  ].join(".");
}

export async function decryptSecret(
  keys: KeyProvider,
  binding: SecretBinding,
  encrypted: string
): Promise<Secret<string>> {
  const [version, keyId, encodedIv, encodedTag, encodedCiphertext] = encrypted.split(".");

  if (version !== FORMAT_VERSION || !keyId || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("The stored secret uses an unsupported format.");
  }

  const key = await keys.byId(keyId);
  if (!key) {
    throw new Error("The key that encrypted this secret is unavailable.");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    assertKeyMaterial(key.material),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));

  // A wrong binding or tampered ciphertext throws here — that is the point.
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");

  return new Secret(plaintext, `${binding.namespace}:${binding.itemId}`);
}

/** Which key id produced a ciphertext, without decrypting it (rotation scans). */
export function keyIdOf(encrypted: string): KeyId | undefined {
  const [version, keyId] = encrypted.split(".");
  return version === FORMAT_VERSION && keyId ? keyId : undefined;
}

/**
 * Re-encrypt under the currently active key. Used by the rotation job; a no-op
 * (returns undefined) when the ciphertext is already on the active key.
 */
export async function rotateSecret(
  keys: KeyProvider,
  binding: SecretBinding,
  encrypted: string
): Promise<string | undefined> {
  const active = await keys.active();
  if (keyIdOf(encrypted) === active.id) return undefined;
  const plaintext = await decryptSecret(keys, binding, encrypted);
  return encryptSecret(keys, binding, plaintext);
}

/** Constant-time comparison for secret-derived values (tokens, digests). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
