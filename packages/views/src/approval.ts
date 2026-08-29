/**
 * Approval presentation.
 *
 * The single highest-stakes piece of UI in the product, and the one it is
 * easiest to get subtly and catastrophically wrong.
 *
 * The spend gate binds a token to a hash of the exact purchase payload. That
 * guarantee is only worth something if the figures a person actually read before
 * tapping "yes" are the figures that went into the hash. Round the total for
 * display, omit a fee because it did not fit, show the line items from an
 * earlier quote — and the user has approved one thing while the token authorizes
 * another. The gate would still work perfectly and would still be theatre.
 *
 * So this module does not format a payload for display. It renders a card *and*
 * returns the hash of the payload it rendered, and a test recomputes the hash
 * from the displayed figures to prove they are the same object. Presentation and
 * authorization cannot drift, because they are produced together.
 *
 * Every channel uses this — Telegram, the web dashboard, iMessage later. An
 * approval card that differs between surfaces is the same bug wearing a
 * different hat.
 */

import { payloadHash, type PurchasePayload } from "@nell/aegis";

export interface ApprovalLine {
  readonly description: string;
  readonly quantity: number;
  /** Minor units. Money is never a float here. */
  readonly unitAmount: number;
  readonly lineTotal: number;
}

export interface ApprovalCard {
  readonly merchant: string;
  readonly lines: readonly ApprovalLine[];
  /** Options that materially change what is bought: seat, date, tier. */
  readonly options: readonly (readonly [string, string])[];
  /**
   * Anything charged beyond the sum of the lines — fees, delivery, tax the
   * merchant adds at the end. Shown explicitly rather than folded into the
   * total, because a total that silently exceeds the visible lines is exactly
   * the surprise the approval exists to prevent.
   */
  readonly extra: number;
  readonly total: number;
  readonly currency: string;
  /**
   * The hash the approval token will be bound to, over the payload THIS card was
   * rendered from.
   */
  readonly payloadHash: string;
}

/**
 * Build the card a person will read.
 *
 * Takes the payload the gate will hash, not a summary of it, so there is no
 * intermediate representation for the two to disagree about.
 */
export function buildApprovalCard(payload: PurchasePayload): ApprovalCard {
  const lines = payload.items.map((item) => ({
    description: item.description,
    quantity: item.quantity,
    unitAmount: item.unitAmount,
    lineTotal: item.quantity * item.unitAmount,
  }));

  const lineSum = lines.reduce((sum, line) => sum + line.lineTotal, 0);

  return {
    merchant: payload.merchant,
    lines,
    options: Object.entries(payload.options).sort(([a], [b]) => (a < b ? -1 : 1)),
    extra: payload.totalAmount - lineSum,
    total: payload.totalAmount,
    currency: payload.currency,
    payloadHash: payloadHash(payload),
  };
}

/**
 * Format minor units for display.
 *
 * Integer arithmetic throughout: dividing by 100 in floating point turns 1999
 * into 19.990000000000002 often enough to matter, and a total that renders
 * wrongly on a purchase confirmation destroys trust far out of proportion to the
 * bug.
 */
export function formatAmount(minorUnits: number, currency: string): string {
  const negative = minorUnits < 0;
  const absolute = Math.abs(minorUnits);
  const major = Math.trunc(absolute / 100);
  const minor = absolute % 100;
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${negative ? "-" : ""}${symbol}${String(major)}.${String(minor).padStart(2, "0")}`;
}

const SYMBOLS: Readonly<Record<string, string>> = {
  GBP: "£",
  USD: "$",
  EUR: "€",
  JPY: "¥",
};

/**
 * Render the card as text, for a chat channel.
 *
 * The wording is chosen to make the decision, not to summarise it. It names the
 * merchant, shows every line, shows any extra separately, and states the total
 * once — and it does not say "confirm?" without the number, which is how a
 * person ends up approving a figure they never saw.
 */
export function renderApprovalCard(card: ApprovalCard): string {
  const lines = card.lines.map(
    (line) =>
      `• ${line.description} ×${String(line.quantity)} — ${formatAmount(line.lineTotal, card.currency)}`
  );

  const options = card.options.map(([key, value]) => `• ${key}: ${value}`);

  const parts = [`${card.merchant}`, "", ...lines];
  if (options.length > 0) parts.push("", ...options);
  if (card.extra !== 0) {
    parts.push("", `Fees and extras: ${formatAmount(card.extra, card.currency)}`);
  }
  parts.push("", `Total: ${formatAmount(card.total, card.currency)}`);
  parts.push("", "Approve this exact amount?");

  return parts.join("\n");
}

/**
 * Whether a card still describes a payload.
 *
 * Used just before the purchase call. The gate already refuses a mismatched
 * token, but by then the failure is an error the user has to interpret; catching
 * it here means the agent can say "the price went up while I was checking out"
 * and offer the new figure, which is a conversation rather than a fault.
 */
export function cardMatches(card: ApprovalCard, payload: PurchasePayload): boolean {
  return card.payloadHash === payloadHash(payload);
}

export interface PriceChange {
  readonly previousTotal: number;
  readonly newTotal: number;
  readonly currency: string;
}

/**
 * Explain a change the user has to re-approve.
 *
 * Says which direction it moved and by how much. "The price changed" makes a
 * person hunt for the difference; "£12 more than when you approved" does not.
 */
export function explainPriceChange(change: PriceChange): string {
  const delta = change.newTotal - change.previousTotal;
  const direction = delta > 0 ? "more" : "less";
  return (
    `The total is now ${formatAmount(change.newTotal, change.currency)} — ` +
    `${formatAmount(Math.abs(delta), change.currency)} ${direction} than when you approved. ` +
    `Approve the new amount?`
  );
}
