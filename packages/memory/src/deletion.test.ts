import { describe, expect, it } from "vitest";
import {
  isRebuildable,
  issueReceipt,
  NEVER_DELETED,
  plan,
  SCOPE_CATEGORIES,
  verifyReceipt,
  type DeletionRequest,
} from "./index.js";

const workspaceId = "personal:abc";
const requestedAt = 1_800_000_000_000;
const completedAt = requestedAt + 4200;

const request: DeletionRequest = {
  workspaceId,
  scope: "integration",
  source: "gmail",
  requestedAt,
};

const categories = [
  { category: "synced-content", count: 1240, rebuildable: false },
  { category: "derived-index", count: 8830, rebuildable: true },
];

describe("deletion receipts", () => {
  it("counts everything removed", () => {
    const receipt = issueReceipt("r1", request, categories, completedAt);
    expect(receipt.totalRecords).toBe(10_070);
    expect(receipt.categories).toHaveLength(2);
  });

  it("records what was deleted, from where, and when", () => {
    const receipt = issueReceipt("r1", request, categories, completedAt);
    expect(receipt).toMatchObject({
      scope: "integration",
      source: "gmail",
      requestedAt,
      completedAt,
    });
  });

  // A claim you cannot show is not a guarantee.
  it("verifies an untouched receipt", () => {
    expect(verifyReceipt(issueReceipt("r1", request, categories, completedAt))).toBe(true);
  });

  it("detects an altered count", () => {
    const receipt = issueReceipt("r1", request, categories, completedAt);
    expect(verifyReceipt({ ...receipt, totalRecords: 1 })).toBe(false);
  });

  it("detects altered categories", () => {
    const receipt = issueReceipt("r1", request, categories, completedAt);
    expect(
      verifyReceipt({
        ...receipt,
        categories: [{ category: "synced-content", count: 1, rebuildable: false }],
      })
    ).toBe(false);
  });

  it("detects a changed scope or source", () => {
    const receipt = issueReceipt("r1", request, categories, completedAt);
    expect(verifyReceipt({ ...receipt, scope: "memory" })).toBe(false);
    expect(verifyReceipt({ ...receipt, source: "outlook" })).toBe(false);
  });

  it("is insensitive to category ordering", () => {
    const forward = issueReceipt("r1", request, categories, completedAt);
    const reversed = issueReceipt("r2", request, [...categories].reverse(), completedAt);
    expect(forward.digest).toBe(reversed.digest);
  });

  it("handles a deletion that removed nothing", () => {
    const receipt = issueReceipt("r1", request, [], completedAt);
    expect(receipt.totalRecords).toBe(0);
    expect(verifyReceipt(receipt)).toBe(true);
  });
});

describe("deletion scopes", () => {
  // The failure this answers: disconnecting stopped the sync but left the index
  // behind, so the user's mail stayed searchable after they revoked access.
  it("removes derived data alongside synced content on disconnect", () => {
    const categories = plan("integration");
    expect(categories).toContain("synced-content");
    expect(categories).toContain("derived-index");
    expect(categories).toContain("extraction-cache");
  });

  it("clears learned memory when asked to forget", () => {
    expect(plan("memory")).toEqual(
      expect.arrayContaining(["preferences", "directives", "brain-cache"])
    );
  });

  it("removes vault material only on account closure", () => {
    expect(plan("account")).toContain("vault-secrets");
    expect(plan("integration")).not.toContain("vault-secrets");
    expect(plan("memory")).not.toContain("vault-secrets");
  });

  it("covers every other scope's categories under account closure", () => {
    const account = new Set(SCOPE_CATEGORIES.account);
    for (const scope of ["integration", "memory", "history"] as const) {
      for (const category of SCOPE_CATEGORIES[scope]) {
        expect(account.has(category)).toBe(true);
      }
    }
  });

  // Removing the audit log would destroy the user's own evidence trail —
  // including the proof that this deletion happened.
  it("never deletes the audit log, under any scope", () => {
    for (const scope of ["integration", "memory", "history", "account"] as const) {
      for (const never of NEVER_DELETED) {
        expect(SCOPE_CATEGORIES[scope]).not.toContain(never);
      }
    }
  });

  it("knows which categories are regenerable from source", () => {
    expect(isRebuildable("derived-index")).toBe(true);
    expect(isRebuildable("brain-cache")).toBe(true);
    // User-authored content is not something we can recreate.
    expect(isRebuildable("preferences")).toBe(false);
    expect(isRebuildable("synced-content")).toBe(false);
  });
});
