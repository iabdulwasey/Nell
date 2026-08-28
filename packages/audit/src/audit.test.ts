import { describe, expect, it } from "vitest";
import { appendEntry, pseudonymize, verifyChain, type AuditEntry } from "./index.js";

const workspaceId = "personal:abc123";
const at = "2026-08-29T10:00:00.000Z";

function chain(count: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let previous: AuditEntry | undefined;
  for (let i = 0; i < count; i += 1) {
    previous = appendEntry(previous, {
      workspaceId,
      action: "vault.fill",
      subject: `item-${String(i)}`,
      at,
    });
    entries.push(previous);
  }
  return entries;
}

describe("audit chain", () => {
  it("starts at sequence 1 with an empty previous digest", () => {
    const [first] = chain(1);
    expect(first?.sequence).toBe(1);
    expect(first?.previousDigest).toBe("");
    expect(first?.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("links each entry to the one before it", () => {
    const entries = chain(3);
    expect(entries[1]?.previousDigest).toBe(entries[0]?.digest);
    expect(entries[2]?.previousDigest).toBe(entries[1]?.digest);
  });

  it("verifies an intact chain", () => {
    expect(verifyChain(chain(5)).valid).toBe(true);
    expect(verifyChain([]).valid).toBe(true);
  });

  // The three tamper cases the chain exists to catch.
  it("detects an edited entry", () => {
    const entries = chain(4);
    const tampered = entries.map((entry, index) =>
      index === 1 ? { ...entry, subject: "rewritten" } : entry
    );
    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/does not match its digest/iu);
  });

  it("detects a removed entry", () => {
    const entries = chain(4);
    const result = verifyChain([entries[0]!, entries[2]!, entries[3]!]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not contiguous/iu);
  });

  it("detects reordering", () => {
    const entries = chain(3);
    const result = verifyChain([entries[1]!, entries[0]!, entries[2]!]);
    expect(result.valid).toBe(false);
  });

  it("is insensitive to detail key order but sensitive to detail content", () => {
    const a = appendEntry(undefined, {
      workspaceId,
      action: "purchase.execute",
      subject: "merchant",
      at,
      detail: { total: 1200, currency: "USD" },
    });
    const b = appendEntry(undefined, {
      workspaceId,
      action: "purchase.execute",
      subject: "merchant",
      at,
      detail: { currency: "USD", total: 1200 },
    });
    expect(a.digest).toBe(b.digest);

    const c = appendEntry(undefined, {
      workspaceId,
      action: "purchase.execute",
      subject: "merchant",
      at,
      detail: { currency: "USD", total: 1300 },
    });
    expect(c.digest).not.toBe(a.digest);
  });

  it("refuses to interleave workspaces in one chain", () => {
    const [first] = chain(1);
    expect(() =>
      appendEntry(first, {
        workspaceId: "personal:other",
        action: "vault.fill",
        subject: "x",
        at,
      })
    ).toThrow(/per-workspace/iu);
  });
});

describe("pseudonymize", () => {
  it("is stable, opaque, and key-dependent", () => {
    const a = pseudonymize("user@example.com", "key-1");
    const b = pseudonymize("user@example.com", "key-1");
    const c = pseudonymize("user@example.com", "key-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("user@example.com");
    expect(a.startsWith("erased:")).toBe(true);
  });
});
