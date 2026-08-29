import { describe, expect, it } from "vitest";
import {
  DEFAULT_HANDOFF_TTL_MS,
  describeReason,
  explainHandoffDenial,
  handoffMessage,
  handoffReasonSchema,
  hashToken,
  markRedeemed,
  mintHandoff,
  redeemHandoff,
  revokeHandoff,
  type HandoffGrant,
  type HandoffReason,
} from "./index.js";

const PEPPER = "pepper-for-tests";
const NOW = 1_700_000_000_000;

function mint(overrides: Partial<Parameters<typeof mintHandoff>[0]> = {}) {
  return mintHandoff({
    workspaceId: "ws-1",
    machineId: "machine-1",
    taskId: "task-1",
    reason: "captcha",
    origin: "https://tickets.example",
    pepper: PEPPER,
    now: NOW,
    ...overrides,
  });
}

function redeem(grant: HandoffGrant, token: string, overrides: Record<string, unknown> = {}) {
  return redeemHandoff([grant], {
    token,
    workspaceId: "ws-1",
    machineId: "machine-1",
    pepper: PEPPER,
    now: NOW + 1000,
    ...overrides,
  });
}

describe("the token is treated as a credential", () => {
  // Whoever opens the link is driving a browser signed into the user's accounts.
  it("is long and unguessable", () => {
    const { token } = mint();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(mint().token).not.toBe(token);
  });

  it("is never stored — only a peppered hash of it", () => {
    const { grant, token } = mint();
    expect(JSON.stringify(grant)).not.toContain(token);
    expect(grant.tokenHash).toBe(hashToken(token, PEPPER));
  });

  it("does not verify under a different pepper", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { pepper: "different" }).ok).toBe(false);
  });
});

describe("redeeming", () => {
  it("unlocks the grant it was minted for", () => {
    const { grant, token } = mint();
    const decision = redeem(grant, token);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.grant.taskId).toBe("task-1");
  });

  it("refuses a token that matches nothing", () => {
    const { grant } = mint();
    const decision = redeem(grant, "not-the-token");
    expect(decision).toEqual({ ok: false, reason: "unknown-token" });
  });

  // A link resent, forwarded, or left in a message history must be inert.
  it("refuses a second use", () => {
    const { grant, token } = mint();
    const used = markRedeemed(grant, NOW + 100);
    expect(redeem(used, token)).toEqual({ ok: false, reason: "already-used" });
  });

  it("refuses after expiry", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { now: NOW + DEFAULT_HANDOFF_TTL_MS })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts right up to the moment it expires", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { now: NOW + DEFAULT_HANDOFF_TTL_MS - 1 }).ok).toBe(true);
  });

  it("refuses a revoked grant", () => {
    const { grant, token } = mint();
    expect(redeem(revokeHandoff(grant, NOW + 10), token)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  // Defence that depends on the caller having filtered correctly ends the first
  // time someone writes a new caller.
  it("checks the workspace even though candidates are workspace-scoped", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { workspaceId: "ws-other" })).toEqual({
      ok: false,
      reason: "wrong-workspace",
    });
  });

  // A token minted to clear a CAPTCHA must not become general access.
  it("is bound to one machine", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { machineId: "machine-2" })).toEqual({
      ok: false,
      reason: "wrong-machine",
    });
  });

  it("picks the right grant out of several outstanding", () => {
    const a = mint({ id: "a" });
    const b = mint({ id: "b", taskId: "task-2" });
    const decision = redeemHandoff([a.grant, b.grant], {
      token: b.token,
      workspaceId: "ws-1",
      machineId: "machine-1",
      pepper: PEPPER,
      now: NOW + 1,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.grant.id).toBe("b");
  });

  it("refuses when nothing is outstanding", () => {
    expect(
      redeemHandoff([], {
        token: "anything",
        workspaceId: "ws-1",
        machineId: "machine-1",
        pepper: PEPPER,
        now: NOW,
      })
    ).toEqual({ ok: false, reason: "unknown-token" });
  });
});

describe("revocation", () => {
  // An outstanding link into a signed-in browser must not outlive its reason.
  it("is idempotent, so cancelling twice does not move the timestamp", () => {
    const { grant } = mint();
    const once = revokeHandoff(grant, NOW + 10);
    expect(revokeHandoff(once, NOW + 999).revokedAt).toBe(NOW + 10);
  });
});

describe("what the user is told", () => {
  // "Tap here" with no context trains people to open unexplained links into
  // their own signed-in accounts.
  it("says what it needs and where", () => {
    const { grant } = mint({ reason: "payment-authentication" });
    const message = handoffMessage(grant, "https://nell.example/t/abc");

    expect(message).toContain("approve the payment with your bank");
    expect(message).toContain("tickets.example");
    expect(message).toContain("https://nell.example/t/abc");
  });

  it("explains every reason it can ask for", () => {
    for (const reason of handoffReasonSchema.options) {
      expect(describeReason(reason as HandoffReason).length).toBeGreaterThan(3);
    }
  });

  it("explains every refusal without leaking whether a token existed", () => {
    for (const reason of [
      "unknown-token",
      "expired",
      "already-used",
      "revoked",
      "wrong-workspace",
      "wrong-machine",
    ] as const) {
      expect(explainHandoffDenial(reason).length).toBeGreaterThan(3);
    }
    // A wrong-workspace token and an unknown token must read identically, or
    // the message itself tells an attacker they guessed a real one.
    expect(explainHandoffDenial("wrong-workspace")).toBe(explainHandoffDenial("unknown-token"));
  });
});
