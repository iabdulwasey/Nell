/**
 * Key providers.
 *
 * Self-host resolves keys from the environment. The hosted tier will implement
 * the same interface over per-tenant data-encryption keys unwrapped by a
 * KMS-held key-encryption key — the crypto layer does not care which it gets.
 */

import {
  assertKeyMaterial,
  keyFromBase64,
  type KeyId,
  type KeyProvider,
  type VaultKey,
} from "./crypto.js";

/**
 * Environment-backed keys for self-host.
 *
 * `SECRET_ENCRYPTION_KEY` is the active key. Retired keys stay readable by
 * listing them in `SECRET_ENCRYPTION_KEYS_PREVIOUS` as `id:base64` pairs, so a
 * rotation can run without downtime.
 */
export class EnvKeyProvider implements KeyProvider {
  readonly #active: VaultKey;
  readonly #all: Map<KeyId, VaultKey>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const encoded = env.SECRET_ENCRYPTION_KEY;
    if (!encoded) {
      throw new Error("SECRET_ENCRYPTION_KEY is required to read or write vault secrets.");
    }

    const activeId = env.SECRET_ENCRYPTION_KEY_ID ?? "k1";
    this.#active = keyFromBase64(activeId, encoded);
    this.#all = new Map([[this.#active.id, this.#active]]);

    for (const entry of (env.SECRET_ENCRYPTION_KEYS_PREVIOUS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const separator = entry.indexOf(":");
      if (separator <= 0) {
        throw new Error("SECRET_ENCRYPTION_KEYS_PREVIOUS entries must be formatted as id:base64.");
      }
      const id = entry.slice(0, separator);
      const material = entry.slice(separator + 1);
      this.#all.set(id, keyFromBase64(id, material));
    }
  }

  active(): Promise<VaultKey> {
    return Promise.resolve(this.#active);
  }

  byId(id: KeyId): Promise<VaultKey | undefined> {
    return Promise.resolve(this.#all.get(id));
  }
}

/** In-memory provider for tests and ephemeral workers. */
export class StaticKeyProvider implements KeyProvider {
  readonly #active: VaultKey;
  readonly #all: Map<KeyId, VaultKey>;

  constructor(active: VaultKey, previous: readonly VaultKey[] = []) {
    assertKeyMaterial(active.material);
    this.#active = active;
    this.#all = new Map([[active.id, active]]);
    for (const key of previous) {
      this.#all.set(key.id, { id: key.id, material: assertKeyMaterial(key.material) });
    }
  }

  active(): Promise<VaultKey> {
    return Promise.resolve(this.#active);
  }

  byId(id: KeyId): Promise<VaultKey | undefined> {
    return Promise.resolve(this.#all.get(id));
  }
}
