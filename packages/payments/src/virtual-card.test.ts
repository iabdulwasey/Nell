import { describe, expect, it } from "vitest";
import type { PurchasePayload } from "@nell/aegis";
import {
  authorizeCard,
  describeCard,
  explainCardDenial,
  issueCard,
  markClosed,
  markUsed,
  sweepExpired,
  toleranceFor,
  CARD_TTL_MS,
  TOLERANCE_CAP,
  TOLERANCE_MINIMUM,
  type CardIssuer,
  type VirtualCard,
} from "./index.js";

const NOW = 1_700_000_000_000;

const payload: PurchasePayload = {
  merchant: "Barbican",
  items: [{ description: "Stalls, row H", quantity: 2, unitAmount: 4500 }],
  options: { date: "2026-10-11" },
  totalAmount: 9000,
  currency: "GBP",
};

class FakeIssuer implements CardIssuer {
  readonly name = "fake";
  issued: { limitAmount: number; merchant: string; expiresAt: number }[] = [];
  closed: string[] = [];
  fail = false;
  failClose = false;

  async issue(spec: {
    workspaceId: string;
    limitAmount: number;
    currency: string;
    merchant: string;
    expiresAt: number;
  }): Promise<{ id: string }> {
    if (this.fail) throw new Error("issuer unavailable");
    this.issued.push(spec);
    return { id: `card-${String(this.issued.length)}` };
  }

  async close(cardId: string): Promise<void> {
    if (this.failClose) throw new Error("close failed");
    this.closed.push(cardId);
  }
}

async function issued(overrides: Partial<PurchasePayload> = {}) {
  const issuer = new FakeIssuer();
  const outcome = await issueCard(issuer, {
    workspaceId: "ws-1",
    taskId: "t-1",
    payload: { ...payload, ...overrides },
    now: NOW,
  });
  if (!outcome.ok) throw new Error(outcome.reason);
  return { issuer, card: outcome.card };
}

describe("the limit comes from the approval", () => {
  /**
   * The property that makes this a different kind of control: if every gate
   * above failed at once, the charge still cannot exceed this, because the
   * entity declining it has never heard of us.
   */
  it("caps the card at the approved total plus a stated tolerance", async () => {
    const { issuer, card } = await issued();

    expect(card.limitAmount).toBe(9000 + toleranceFor(9000));
    expect(issuer.issued[0]?.limitAmount).toBe(card.limitAmount);
  });

  // A card worth more than the user agreed to must not be something a caller
  // can produce by passing the wrong number.
  it("records the hash of the purchase it exists for", async () => {
    const { card } = await issued();
    expect(card.payloadHash).toHaveLength(64);
  });

  it("locks the card to the merchant where the issuer supports it", async () => {
    const { issuer } = await issued();
    expect(issuer.issued[0]?.merchant).toBe("Barbican");
  });

  // An open card is an open line of credit sitting in a database.
  it("expires within a checkout's plausible lifetime", async () => {
    const { card } = await issued();
    expect(card.expiresAt - card.issuedAt).toBe(CARD_TTL_MS);
  });

  it("reports an issuer failure rather than throwing", async () => {
    const issuer = new FakeIssuer();
    issuer.fail = true;

    const outcome = await issueCard(issuer, {
      workspaceId: "ws-1",
      taskId: "t-1",
      payload,
      now: NOW,
    });
    expect(outcome).toMatchObject({ ok: false });
  });

  /**
   * A booking that charges nothing today would otherwise leave a live card
   * against a reservation whose cancellation fee lands next week.
   */
  it("issues nothing for a purchase that charges nothing", async () => {
    const issuer = new FakeIssuer();
    const outcome = await issueCard(issuer, {
      workspaceId: "ws-1",
      taskId: "t-1",
      payload: { ...payload, totalAmount: 0 },
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    expect(issuer.issued).toHaveLength(0);
  });
});

describe("tolerance", () => {
  /**
   * Necessity, not generosity: a currency conversion moves between quote and
   * capture, a hotel adds a deposit hold, a restaurant pre-authorizes for a tip.
   * A card limited to the exact penny declines those, and a decline at checkout
   * looks like a bug in Nell rather than a policy working.
   */
  it("allows a little over on a small purchase", () => {
    expect(toleranceFor(500)).toBe(TOLERANCE_MINIMUM);
  });

  it("scales with the total", () => {
    expect(toleranceFor(10_000)).toBe(500);
  });

  // A percentage alone would allow a large tolerance on a large purchase, which
  // is exactly where it is least acceptable.
  it("is capped, so a big purchase does not get a big allowance", () => {
    expect(toleranceFor(1_000_000)).toBe(TOLERANCE_CAP);
    expect(toleranceFor(1_000_000)).toBeLessThan(1_000_000 * 0.05);
  });

  it("never returns less than the floor", () => {
    for (const total of [1, 100, 999, 5000]) {
      expect(toleranceFor(total)).toBeGreaterThanOrEqual(TOLERANCE_MINIMUM);
    }
  });
});

describe("using a card", () => {
  const options = { workspaceId: "ws-1", payload, now: NOW + 1000 };

  it("authorizes the purchase it was issued for", async () => {
    const { card } = await issued();
    expect(authorizeCard(card, options).ok).toBe(true);
  });

  /**
   * A second check of something the spend gate already verified. The gate checks
   * a token against a payload; this checks a card against one. They can disagree
   * only if something went wrong in between, which is the moment worth catching.
   */
  it("refuses a card issued for a different purchase", async () => {
    const { card } = await issued();
    const different: PurchasePayload = { ...payload, merchant: "Somewhere else" };

    expect(authorizeCard(card, { ...options, payload: different })).toEqual({
      ok: false,
      reason: "wrong-purchase",
    });
  });

  // A card issued for a £90 ticket must not be quietly spent on something else
  // costing £90.
  it("refuses when the items changed at the same total", async () => {
    const { card } = await issued();
    const swapped: PurchasePayload = {
      ...payload,
      items: [{ description: "Something else entirely", quantity: 1, unitAmount: 9000 }],
    };

    expect(authorizeCard(card, { ...options, payload: swapped }).ok).toBe(false);
  });

  it("refuses a card that has been used", async () => {
    const { card } = await issued();
    expect(authorizeCard(markUsed(card, 9000, NOW), options)).toEqual({
      ok: false,
      reason: "already-used",
    });
  });

  it("refuses a closed card", async () => {
    const { card } = await issued();
    expect(authorizeCard(markClosed(card, NOW), options)).toEqual({ ok: false, reason: "closed" });
  });

  it("refuses an expired card", async () => {
    const { card } = await issued();
    expect(authorizeCard(card, { ...options, now: NOW + CARD_TTL_MS })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is bound to its workspace", async () => {
    const { card } = await issued();
    expect(authorizeCard(card, { ...options, workspaceId: "ws-other" })).toEqual({
      ok: false,
      reason: "wrong-workspace",
    });
  });

  it("retires the card in the same step as recording the charge", async () => {
    const { card } = await issued();
    const used = markUsed(card, 9150, NOW + 2000);

    expect(used.state).toBe("used");
    expect(used.authorizedAmount).toBe(9150);
    expect(used.closedAt).toBe(NOW + 2000);
  });

  it("does not reopen a used card by closing it", async () => {
    const { card } = await issued();
    const used = markUsed(card, 9000, NOW);
    expect(markClosed(used, NOW + 1000).state).toBe("used");
  });
});

describe("the sweep", () => {
  /**
   * A task that crashed between issuing and charging leaves a card behind, and
   * an issuer holding a thousand forgotten open cards has recreated the
   * stored-card problem virtual cards exist to solve.
   */
  it("closes cards that outlived their checkout", async () => {
    const { issuer, card } = await issued();
    const closed = await sweepExpired(issuer, [card], NOW + CARD_TTL_MS + 1);

    expect(closed).toHaveLength(1);
    expect(closed[0]?.state).toBe("expired");
    expect(issuer.closed).toEqual([card.id]);
  });

  it("leaves a live card alone", async () => {
    const { issuer, card } = await issued();
    expect(await sweepExpired(issuer, [card], NOW + 1000)).toEqual([]);
    expect(issuer.closed).toEqual([]);
  });

  it("ignores cards that are already used or closed", async () => {
    const { issuer, card } = await issued();
    const done = [markUsed(card, 9000, NOW), markClosed(card, NOW)];

    expect(await sweepExpired(issuer, done, NOW + CARD_TTL_MS + 1)).toEqual([]);
  });

  /**
   * A card recorded as closed that is actually live is worse than one known to
   * be outstanding, because nothing will ever try again.
   */
  it("does not record a card as closed when the call failed", async () => {
    const { issuer, card } = await issued();
    issuer.failClose = true;

    expect(await sweepExpired(issuer, [card], NOW + CARD_TTL_MS + 1)).toEqual([]);
  });
});

describe("what the user is told", () => {
  // Someone who approved £90 and later sees a £91.50 charge should have been
  // told the card allows a little over, not discover the gap on a statement.
  it("states the cap and that it covers a little over", async () => {
    const { card } = await issued();
    const description = describeCard(card);

    expect(description).toContain("Barbican");
    expect(description).toContain("94.50");
    expect(description).toContain("a little over");
    expect(description).toContain("closes as soon as it is charged");
  });

  it("explains every refusal", () => {
    for (const reason of [
      "wrong-purchase",
      "already-used",
      "closed",
      "expired",
      "wrong-workspace",
      "over-limit",
    ] as const) {
      expect(explainCardDenial(reason).length).toBeGreaterThan(10);
    }
  });

  it("offers a way forward when the price moved", () => {
    expect(explainCardDenial("wrong-purchase")).toContain("approve the new amount");
  });
});

describe("the limit is a real bound", () => {
  // The whole point: even asked to charge more, the card says no.
  it("refuses a total above the limit", async () => {
    const card: VirtualCard = (await issued()).card;
    const bigger: PurchasePayload = { ...payload, totalAmount: card.limitAmount + 1 };

    // Different payload, so this is caught as the wrong purchase first — which
    // is the stronger refusal.
    expect(authorizeCard(card, { workspaceId: "ws-1", payload: bigger, now: NOW }).ok).toBe(false);

    // And directly: a card whose recorded hash matches but whose amount exceeds
    // the limit is refused on the limit.
    const tampered: VirtualCard = { ...card, limitAmount: 100 };
    expect(authorizeCard(tampered, { workspaceId: "ws-1", payload, now: NOW })).toEqual({
      ok: false,
      reason: "over-limit",
    });
  });
});
