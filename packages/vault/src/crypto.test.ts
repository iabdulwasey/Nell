import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  keyIdOf,
  rotateSecret,
  safeEqual,
  type SecretBinding,
} from "./crypto.js";
import { StaticKeyProvider } from "./keys.js";
import { Secret } from "./secret.js";

const keys = new StaticKeyProvider({ id: "k1", material: randomBytes(32) });

const binding: SecretBinding = {
  workspaceId: "personal:abc123",
  namespace: "vault",
  itemId: "item-1",
};

describe("vault crypto", () => {
  it("round-trips a secret", async () => {
    const encrypted = await encryptSecret(keys, binding, "hunter2");
    const decrypted = await decryptSecret(keys, binding, encrypted);
    expect(decrypted.expose()).toBe("hunter2");
  });

  it("never emits the plaintext in the ciphertext", async () => {
    const encrypted = await encryptSecret(keys, binding, "hunter2");
    expect(encrypted).not.toContain("hunter2");
    expect(encrypted.startsWith("v2.k1.")).toBe(true);
  });

  it("uses a fresh IV per write, so identical plaintexts differ", async () => {
    const a = await encryptSecret(keys, binding, "same");
    const b = await encryptSecret(keys, binding, "same");
    expect(a).not.toBe(b);
  });

  // The core tenancy guarantee: a ciphertext is bound to exactly one slot.
  it("refuses a ciphertext moved to another workspace", async () => {
    const encrypted = await encryptSecret(keys, binding, "hunter2");
    await expect(
      decryptSecret(keys, { ...binding, workspaceId: "personal:evil" }, encrypted)
    ).rejects.toThrow();
  });

  it("refuses a ciphertext moved to another item", async () => {
    const encrypted = await encryptSecret(keys, binding, "hunter2");
    await expect(
      decryptSecret(keys, { ...binding, itemId: "item-2" }, encrypted)
    ).rejects.toThrow();
  });

  it("refuses a ciphertext moved to another namespace", async () => {
    const encrypted = await encryptSecret(keys, binding, "hunter2");
    await expect(
      decryptSecret(keys, { ...binding, namespace: "other" }, encrypted)
    ).rejects.toThrow();
  });

  it("refuses tampered ciphertext", async () => {
    const encrypted = await encryptSecret(keys, binding, "hunter2");
    const parts = encrypted.split(".");
    const body = Buffer.from(parts[4] ?? "", "base64url");
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[4] = body.toString("base64url");
    await expect(decryptSecret(keys, binding, parts.join("."))).rejects.toThrow();
  });

  it("rejects an unknown wire format", async () => {
    await expect(decryptSecret(keys, binding, "v1.a.b.c")).rejects.toThrow(/unsupported format/iu);
  });

  it("accepts a Secret wrapper as input", async () => {
    const encrypted = await encryptSecret(keys, binding, new Secret("wrapped", "test"));
    expect((await decryptSecret(keys, binding, encrypted)).expose()).toBe("wrapped");
  });
});

describe("key rotation", () => {
  it("keeps old ciphertexts readable and re-encrypts to the active key", async () => {
    const oldKey = { id: "k1", material: randomBytes(32) };
    const newKey = { id: "k2", material: randomBytes(32) };

    const oldProvider = new StaticKeyProvider(oldKey);
    const encrypted = await encryptSecret(oldProvider, binding, "legacy");
    expect(keyIdOf(encrypted)).toBe("k1");

    // After rotation the new key is active but the old one stays readable.
    const rotating = new StaticKeyProvider(newKey, [oldKey]);
    expect((await decryptSecret(rotating, binding, encrypted)).expose()).toBe("legacy");

    const reEncrypted = await rotateSecret(rotating, binding, encrypted);
    expect(reEncrypted).toBeDefined();
    expect(keyIdOf(reEncrypted ?? "")).toBe("k2");
    expect((await decryptSecret(rotating, binding, reEncrypted ?? "")).expose()).toBe("legacy");
  });

  it("is a no-op when already on the active key", async () => {
    const encrypted = await encryptSecret(keys, binding, "current");
    expect(await rotateSecret(keys, binding, encrypted)).toBeUndefined();
  });

  it("fails closed when the encrypting key is gone", async () => {
    const orphanKey = { id: "k9", material: randomBytes(32) };
    const encrypted = await encryptSecret(new StaticKeyProvider(orphanKey), binding, "orphaned");
    await expect(decryptSecret(keys, binding, encrypted)).rejects.toThrow(/unavailable/iu);
  });
});

describe("safeEqual", () => {
  it("compares equal and unequal values", () => {
    expect(safeEqual("token", "token")).toBe(true);
    expect(safeEqual("token", "tokeN")).toBe(false);
    expect(safeEqual("token", "longer-token")).toBe(false);
  });
});
