import { describe, expect, it } from "vitest";
import {
  authorizeStanding,
  describeEnvelope,
  explainStandingDenial,
  markStandingSpent,
  mintStandingApproval,
  revokeStanding,
  STANDING_APPROVAL_TTL_MS,
  STANDING_CEILING,
  type Envelope,
  type PurchasePayload,
  type StandingApproval,
} from "./index.js";

const NOW = 1_700_000_000_000;
const PEPPER = "pepper";

const envelope: Envelope = {
  merchant: "Barbican",
  description: "Two tickets to the late show",
  maxUnitAmount: 12_000,
  maxQuantity: 2,
  maxTotalAmount: 25_000,
  currency: "GBP",
};

function mint(overrides: Partial<Envelope> = {}) {
  const outcome = mintStandingApproval({
    workspaceId: "ws-1",
    taskId: "task-1",
    envelope: { ...envelope, ...overrides },
    pepper: PEPPER,
    now: NOW,
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome;
}

function payload(overrides: Partial<PurchasePayload> = {}): PurchasePayload {
  return {
    merchant: "Barbican",
    items: [{ description: "Stalls", quantity: 2, unitAmount: 9000 }],
    options: {},
    totalAmount: 18_000,
    currency: "GBP",
    ...overrides,
  };
}

function authorize(approval: StandingApproval, token: string, p: PurchasePayload = payload()) {
  return authorizeStanding([approval], {
    token,
    workspaceId: "ws-1",
    payload: p,
    pepper: PEPPER,
    now: NOW + 1000,
  });
}

describe("an envelope, not a payload", () => {
  /**
   * This instrument is deliberately weaker than an exact-payload approval,
   * because it has to be granted before the price is known. The weakness is the
   * design, and every bound is checked separately.
   */
  it("authorizes a purchase inside every bound", () => {
    const { approval, token } = mint();
    expect(authorize(approval, token).ok).toBe(true);
  });

  it("refuses a different seller", () => {
    const { approval, token } = mint();
    expect(authorize(approval, token, payload({ merchant: "Someone else" }))).toEqual({
      ok: false,
      reason: "wrong-merchant",
    });
  });

  it("refuses more than the user asked for", () => {
    const { approval, token } = mint();
    const four = payload({
      items: [{ description: "Stalls", quantity: 4, unitAmount: 5000 }],
      totalAmount: 20_000,
    });
    expect(authorize(approval, token, four)).toEqual({ ok: false, reason: "too-many" });
  });

  it("refuses a unit price above the limit", () => {
    const { approval, token } = mint();
    const dear = payload({
      items: [{ description: "Stalls", quantity: 1, unitAmount: 20_000 }],
      totalAmount: 20_000,
    });
    expect(authorize(approval, token, dear)).toEqual({
      ok: false,
      reason: "unit-too-expensive",
    });
  });

  /**
   * Unit price and quantity can both be inside their bounds while the total is
   * not, once fees are added — so the total is checked last and independently.
   */
  it("refuses a total pushed over by fees", () => {
    const { approval, token } = mint();
    const withFees = payload({ totalAmount: 26_000 });
    expect(authorize(approval, token, withFees)).toEqual({ ok: false, reason: "over-total" });
  });

  // "That is outside what you approved" leaves a user unable to tell whether the
  // price moved, the quantity was wrong, or the seller was not who they expected.
  it("names which bound was exceeded", () => {
    for (const reason of [
      "wrong-merchant",
      "too-many",
      "unit-too-expensive",
      "over-total",
    ] as const) {
      expect(explainStandingDenial(reason)).not.toBe(explainStandingDenial("expired"));
    }
  });
});

describe("standing means bounded, not open-ended", () => {
  it("expires in hours", () => {
    const { approval, token } = mint();
    expect(
      authorizeStanding([approval], {
        token,
        workspaceId: "ws-1",
        payload: payload(),
        pepper: PEPPER,
        now: NOW + STANDING_APPROVAL_TTL_MS,
      })
    ).toEqual({ ok: false, reason: "expired" });
  });

  // A retry loop or a duplicated webhook must not buy four.
  it("buys once and is spent", () => {
    const { approval, token } = mint();
    expect(authorize(markStandingSpent(approval, NOW + 10), token)).toEqual({
      ok: false,
      reason: "already-spent",
    });
  });

  it("can be cancelled", () => {
    const { approval, token } = mint();
    expect(authorize(revokeStanding(approval, NOW + 10), token)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("is bound to its workspace", () => {
    const { approval, token } = mint();
    expect(
      authorizeStanding([approval], {
        token,
        workspaceId: "ws-other",
        payload: payload(),
        pepper: PEPPER,
        now: NOW + 1000,
      })
    ).toEqual({ ok: false, reason: "wrong-workspace" });
  });

  it("stores only a hash of its token", () => {
    const { approval, token } = mint();
    expect(JSON.stringify(approval)).not.toContain(token);
    expect(authorize(approval, "guessed")).toEqual({ ok: false, reason: "unknown-token" });
  });

  it("reports having no standing permission at all", () => {
    expect(
      authorizeStanding([], {
        token: "x",
        workspaceId: "ws-1",
        payload: payload(),
        pepper: PEPPER,
        now: NOW,
      })
    ).toEqual({ ok: false, reason: "no-approval" });
  });
});

describe("refusing to mint something unbounded", () => {
  it("caps what may be agreed in advance at all", () => {
    const outcome = mintStandingApproval({
      workspaceId: "ws-1",
      taskId: "task-1",
      envelope: { ...envelope, maxTotalAmount: STANDING_CEILING + 1, maxUnitAmount: 200_000 },
      pepper: PEPPER,
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("Ask me at the time");
  });

  /**
   * Headroom above the item prices is normal — it is the booking fee, which is
   * exactly how someone thinks about a ticket price. What is not normal is
   * headroom so large the total stops bounding anything: "two at 120" with a
   * 10,000 ceiling is not a limit, it is a number in the same sentence as one.
   */
  it("allows headroom for a booking fee", () => {
    const outcome = mintStandingApproval({
      workspaceId: "ws-1",
      taskId: "task-1",
      // 2 x 120 = 240 of tickets, 250 ceiling: 10 for the fee.
      envelope: { ...envelope, maxUnitAmount: 12_000, maxQuantity: 2, maxTotalAmount: 25_000 },
      pepper: PEPPER,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
  });

  it("refuses headroom so large the ceiling bounds nothing", () => {
    const outcome = mintStandingApproval({
      workspaceId: "ws-1",
      taskId: "task-1",
      envelope: { ...envelope, maxUnitAmount: 1000, maxQuantity: 2, maxTotalAmount: 50_000 },
      pepper: PEPPER,
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("not really be limiting");
  });

  // A user who has agreed to something that cannot happen has agreed to nothing.
  it("refuses a total below the price of one", () => {
    const outcome = mintStandingApproval({
      workspaceId: "ws-1",
      taskId: "task-1",
      envelope: { ...envelope, maxUnitAmount: 12_000, maxQuantity: 2, maxTotalAmount: 5000 },
      pepper: PEPPER,
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("below the price of one");
  });

  it("refuses an envelope that is not a purchase", () => {
    const outcome = mintStandingApproval({
      workspaceId: "ws-1",
      taskId: "task-1",
      envelope: { ...envelope, maxQuantity: 0 },
      pepper: PEPPER,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("what the user actually agrees to", () => {
  /**
   * "Buy the tickets when they appear" is not something a person can evaluate.
   * Limits are.
   */
  it("is a sentence of limits, not an instruction", () => {
    const said = describeEnvelope(envelope, NOW + STANDING_APPROVAL_TTL_MS, NOW);

    expect(said).toContain("up to 2");
    expect(said).toContain("120.00 GBP each");
    expect(said).toContain("250.00 GBP in total");
    expect(said).toContain("buy once");
    expect(said).toContain("cancel this at any time");
  });

  it("says how long it lasts", () => {
    expect(describeEnvelope(envelope, NOW + 3_600_000, NOW)).toContain("1 hour");
    expect(describeEnvelope(envelope, NOW + 5 * 3_600_000, NOW)).toContain("5 hours");
  });
});
