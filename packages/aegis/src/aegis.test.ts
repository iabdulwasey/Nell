import { describe, expect, it } from "vitest";
import {
  afterNavigation,
  authorizeOperation,
  authorizeSpend,
  authorizeTool,
  checkOrigin,
  markFilled,
  mintApproval,
  payloadHash,
  scrubSecrets,
  UNTAINTED,
  type PurchasePayload,
} from "./index.js";

const workspaceId = "personal:abc123";
const now = 1_800_000_000_000;

const payload: PurchasePayload = {
  merchant: "Nozomi Sushi",
  items: [{ description: "Dinner for 4", quantity: 1, unitAmount: 24_000 }],
  options: { date: "2026-09-04", time: "20:00" },
  totalAmount: 24_000,
  currency: "USD",
};

describe("spend gate", () => {
  it("allows a purchase matching a fresh approval", () => {
    const token = mintApproval({ workspaceId, payload, now });
    const decision = authorizeSpend({ token, workspaceId, payload, now });
    expect(decision.allowed).toBe(true);
  });

  it("refuses a purchase with no approval at all", () => {
    const decision = authorizeSpend({
      token: undefined,
      workspaceId,
      payload,
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "no-approval" });
  });

  // The "$200 cancellation fee" failure: the agent must not book what the user
  // only asked it to find.
  it("refuses when the total changed after approval", () => {
    const token = mintApproval({ workspaceId, payload, now });
    const pricier = { ...payload, totalAmount: 31_000 };
    const decision = authorizeSpend({
      token,
      workspaceId,
      payload: pricier,
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "payload-changed" });
  });

  it("refuses when a material option changed", () => {
    const token = mintApproval({ workspaceId, payload, now });
    const rescheduled = {
      ...payload,
      options: { ...payload.options, date: "2026-09-05" },
    };
    const decision = authorizeSpend({
      token,
      workspaceId,
      payload: rescheduled,
      now,
    });
    expect(decision).toEqual({ allowed: false, reason: "payload-changed" });
  });

  it("refuses a reused (already spent) approval", () => {
    const token = mintApproval({ workspaceId, payload, now });
    const first = authorizeSpend({ token, workspaceId, payload, now });
    expect(first.allowed).toBe(true);
    const replayed = authorizeSpend({
      token: first.allowed ? first.token : undefined,
      workspaceId,
      payload,
      now,
    });
    expect(replayed).toEqual({ allowed: false, reason: "already-spent" });
  });

  it("refuses an expired approval", () => {
    const token = mintApproval({ workspaceId, payload, now, ttlMs: 1000 });
    const decision = authorizeSpend({
      token,
      workspaceId,
      payload,
      now: now + 2000,
    });
    expect(decision).toEqual({ allowed: false, reason: "expired" });
  });

  it("refuses an approval minted for another workspace", () => {
    const token = mintApproval({ workspaceId: "personal:other", payload, now });
    const decision = authorizeSpend({ token, workspaceId, payload, now });
    expect(decision).toEqual({ allowed: false, reason: "wrong-workspace" });
  });

  it("enforces the remaining budget cap", () => {
    const token = mintApproval({ workspaceId, payload, now });
    const decision = authorizeSpend({
      token,
      workspaceId,
      payload,
      now,
      remainingBudget: 10_000,
    });
    expect(decision).toEqual({ allowed: false, reason: "over-budget" });
  });

  it("hashes item order-insensitively but content-sensitively", () => {
    const a: PurchasePayload = {
      ...payload,
      items: [
        { description: "A", quantity: 1, unitAmount: 100 },
        { description: "B", quantity: 2, unitAmount: 200 },
      ],
    };
    const reordered: PurchasePayload = { ...a, items: [...a.items].reverse() };
    const changed: PurchasePayload = {
      ...a,
      items: [
        { description: "A", quantity: 9, unitAmount: 100 },
        { description: "B", quantity: 2, unitAmount: 200 },
      ],
    };
    expect(payloadHash(a)).toBe(payloadHash(reordered));
    expect(payloadHash(a)).not.toBe(payloadHash(changed));
  });
});

describe("origin gate", () => {
  const allowlist = ["https://chase.com", "https://secure.chase.com"];

  it("allows an exact allowlisted origin", () => {
    expect(checkOrigin({ actualOrigin: "https://chase.com", allowlist }).allowed).toBe(true);
  });

  // The look-alike-domain attack.
  it("refuses a confusable domain", () => {
    expect(checkOrigin({ actualOrigin: "https://chase.com.evil.io", allowlist })).toEqual({
      allowed: false,
      reason: "not-allowlisted",
    });
    expect(checkOrigin({ actualOrigin: "https://chase-com.io", allowlist })).toEqual({
      allowed: false,
      reason: "not-allowlisted",
    });
  });

  it("refuses a different port or scheme", () => {
    expect(checkOrigin({ actualOrigin: "https://chase.com:8443", allowlist }).allowed).toBe(false);
    expect(checkOrigin({ actualOrigin: "http://chase.com", allowlist })).toEqual({
      allowed: false,
      reason: "insecure-scheme",
    });
  });

  it("refuses when no origins are approved yet", () => {
    expect(checkOrigin({ actualOrigin: "https://chase.com", allowlist: [] })).toEqual({
      allowed: false,
      reason: "empty-allowlist",
    });
  });

  it("refuses a malformed origin", () => {
    expect(checkOrigin({ actualOrigin: "not a url", allowlist })).toEqual({
      allowed: false,
      reason: "malformed-origin",
    });
  });
});

describe("taint machine", () => {
  const filled = markFilled(UNTAINTED, "https://bank.example", ["#password"]);

  it("blocks reading a filled value back", () => {
    expect(authorizeOperation(filled, "read-value").allowed).toBe(false);
  });

  it("blocks clipboard and downloads while tainted", () => {
    expect(authorizeOperation(filled, "read-clipboard").allowed).toBe(false);
    expect(authorizeOperation(filled, "download").allowed).toBe(false);
  });

  it("allows navigation and clicking to continue the task", () => {
    expect(authorizeOperation(filled, "click").allowed).toBe(true);
    expect(authorizeOperation(filled, "navigate").allowed).toBe(true);
  });

  it("allows text and screenshots but demands scrubbing", () => {
    expect(authorizeOperation(filled, "read-text")).toEqual({
      allowed: true,
      scrub: true,
    });
    expect(authorizeOperation(filled, "screenshot")).toEqual({
      allowed: true,
      scrub: true,
    });
  });

  it("imposes nothing before any secret is filled", () => {
    expect(authorizeOperation(UNTAINTED, "read-value")).toEqual({
      allowed: true,
      scrub: false,
    });
  });

  it("clears taint only on leaving the fill origin", () => {
    expect(afterNavigation(filled, "https://bank.example").tainted).toBe(true);
    expect(afterNavigation(filled, "https://elsewhere.example").tainted).toBe(false);
  });

  it("scrubs secret values out of page text", () => {
    const text = "Welcome. Your password is hunter2xyz and it is secret.";
    expect(scrubSecrets(text, ["hunter2xyz"])).toBe(
      "Welcome. Your password is [redacted] and it is secret."
    );
  });
});

describe("provenance gate", () => {
  // The email prompt-injection that phished a closed competitor.
  it("refuses a consequential action requested only by untrusted content", () => {
    const decision = authorizeTool(
      { newContext: ["untrusted"], userConfirmed: false },
      "send-message"
    );
    expect(decision.allowed).toBe(false);
  });

  it("still allows reading and searching from untrusted context", () => {
    expect(authorizeTool({ newContext: ["untrusted"], userConfirmed: false }, "read").allowed).toBe(
      true
    );
    expect(
      authorizeTool({ newContext: ["untrusted"], userConfirmed: false }, "search").allowed
    ).toBe(true);
  });

  it("allows a consequential action the user actually asked for", () => {
    expect(authorizeTool({ newContext: ["user"], userConfirmed: false }, "spend").allowed).toBe(
      true
    );
  });

  it("allows untrusted-triggered actions once the user confirms", () => {
    expect(authorizeTool({ newContext: ["untrusted"], userConfirmed: true }, "spend").allowed).toBe(
      true
    );
  });

  it("guards every consequential tool class", () => {
    for (const tool of [
      "spend",
      "send-message",
      "use-credential",
      "write-memory",
      "manage-monitor",
      "delete-data",
    ] as const) {
      expect(authorizeTool({ newContext: ["untrusted"], userConfirmed: false }, tool).allowed).toBe(
        false
      );
    }
  });
});
