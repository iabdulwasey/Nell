/**
 * @nell/vault
 *
 * Encrypted secret vault (AES-256-GCM, per-item AAD binding, key-id'd wire
 * format for rotation) and the Secret<T> wrapper that keeps plaintext out of
 * logs and model context. Secretless browser autofill builds on this: the model
 * receives an opaque handle, the server decrypts and injects the value.
 *
 * Governed by: docs/security-model.md
 */

export {
  assertKeyMaterial,
  decryptSecret,
  encryptSecret,
  keyFromBase64,
  keyIdOf,
  rotateSecret,
  safeEqual,
  type KeyId,
  type KeyProvider,
  type SecretBinding,
  type VaultKey,
} from "./crypto.js";

export { EnvKeyProvider, StaticKeyProvider } from "./keys.js";

export { isSecret, Secret, secret } from "./secret.js";

export {
  addressSchema,
  identitySchema,
  isLuhnValid,
  loginSecretSchema,
  parseVaultItem,
  paymentCardBrand,
  paymentCardSchema,
  phoneSchema,
  serializeVaultItem,
  vaultItemKindSchema,
  vaultItemValueSchema,
  type VaultItemKind,
  type VaultItemValue,
} from "./items.js";
