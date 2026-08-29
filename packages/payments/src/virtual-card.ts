/**
 * Single-use virtual cards.
 *
 * Every other spending control in this system is our own code checking itself.
 * The approval gate is careful, the audit log is honest, the executor is a real
 * chokepoint — and all of it is software we wrote, which means a bug in it is a
 * bug in the control. This is the one place that stops being true.
 *
 * A card issued for one purchase, with a limit equal to what the user approved,
 * is enforced by the card network. If every gate above it failed simultaneously
 * — the approval hash mismatched and nobody noticed, the executor skipped a
 * check, the model invented a purchase — the charge still cannot exceed the
 * limit, because the entity declining it has never heard of us. That is a
 * different kind of guarantee from the others, and it is worth the complexity.
 *
 * Two things this module takes seriously:
 *
 * **The limit is derived from the approval, not passed alongside it.** A card is
 * minted from the same payload hash the spend gate checks, so a card worth more
 * than the user agreed to is not something a caller can produce by passing the
 * wrong number.
 *
 * **A card that outlives its purchase is a standing liability.** Cards close on
 * use and expire on a timer, and a sweep closes anything that slipped through.
 * An issuer with a thousand forgotten open cards has recreated the stored-card
 * problem it was meant to solve.
 *
 * The issuing adapter itself is commercial (`/ee/stripe-issuing`). This file is
 * the policy, which stays in the core so a self-hoster can read exactly what
 * would be authorized on their behalf.
 */

import { payloadHash, type PurchasePayload } from "@nell/aegis";

export type CardState = "issued" | "used" | "closed" | "expired";

export interface VirtualCard {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  /** Hash of the purchase this card exists for. The binding, not a label. */
  readonly payloadHash: string;
  /** Maximum the network will authorize, in minor units. */
  readonly limitAmount: number;
  readonly currency: string;
  /** Merchant name, for the issuer's own merchant lock where supported. */
  readonly merchant: string;
  readonly state: CardState;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly closedAt?: number;
  /** What was actually charged, once the network reports it. */
  readonly authorizedAmount?: number;
}

/**
 * How much above the approved total the card will authorize.
 *
 * Not generosity — necessity. Merchants routinely authorize slightly more than
 * the final total: a currency conversion moves between quote and capture, a
 * hotel adds a deposit hold, a restaurant pre-authorizes for a tip. A card
 * limited to the exact penny declines those, and a decline at checkout is a
 * failed task that looks like a bug in Nell rather than a policy working.
 *
 * Five percent or two units, whichever is larger, and capped. The cap matters:
 * a percentage alone would allow a large tolerance on a large purchase, which is
 * exactly where the tolerance is least acceptable.
 */
export const TOLERANCE_PERCENT = 5;
export const TOLERANCE_MINIMUM = 200;
export const TOLERANCE_CAP = 2000;

export function toleranceFor(totalAmount: number): number {
  const proportional = Math.ceil((totalAmount * TOLERANCE_PERCENT) / 100);
  return Math.min(TOLERANCE_CAP, Math.max(TOLERANCE_MINIMUM, proportional));
}

/**
 * A card lives only as long as a checkout plausibly takes. Anything longer is an
 * open line of credit sitting in a database.
 */
export const CARD_TTL_MS = 30 * 60 * 1000;

export interface IssueRequest {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly payload: PurchasePayload;
  readonly now: number;
  readonly ttlMs?: number;
}

/**
 * What an issuer must provide. Narrow deliberately: there is no "raise the
 * limit" and no "reopen", because both are operations that would let a bug
 * upstream turn into unbounded spending.
 */
export interface CardIssuer {
  readonly name: string;
  issue(spec: {
    readonly workspaceId: string;
    readonly limitAmount: number;
    readonly currency: string;
    readonly merchant: string;
    readonly expiresAt: number;
  }): Promise<{ readonly id: string }>;

  close(cardId: string): Promise<void>;
}

export type IssueOutcome =
  | { readonly ok: true; readonly card: VirtualCard }
  | { readonly ok: false; readonly reason: string };

/**
 * Mint a card for an approved purchase.
 *
 * The limit comes from the payload, and the payload's hash is recorded on the
 * card. Anything that later wants to use this card must present a payload
 * hashing to the same value, so a card issued for a £96 concert ticket cannot be
 * quietly spent on something else costing £96.
 */
export async function issueCard(issuer: CardIssuer, request: IssueRequest): Promise<IssueOutcome> {
  const { payload } = request;

  if (payload.totalAmount <= 0) {
    // A zero-value purchase does not need a card, and issuing one for a booking
    // that charges nothing today would leave a live card against a reservation
    // whose cancellation fee lands next week.
    return { ok: false, reason: "This purchase charges nothing now, so no card is needed." };
  }

  const limitAmount = payload.totalAmount + toleranceFor(payload.totalAmount);
  const expiresAt = request.now + (request.ttlMs ?? CARD_TTL_MS);

  try {
    const issued = await issuer.issue({
      workspaceId: request.workspaceId,
      limitAmount,
      currency: payload.currency,
      merchant: payload.merchant,
      expiresAt,
    });

    return {
      ok: true,
      card: {
        id: issued.id,
        workspaceId: request.workspaceId,
        taskId: request.taskId,
        payloadHash: payloadHash(payload),
        limitAmount,
        currency: payload.currency,
        merchant: payload.merchant,
        state: "issued",
        issuedAt: request.now,
        expiresAt,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Could not issue a card.",
    };
  }
}

export type CardDenialReason =
  | "wrong-purchase"
  | "already-used"
  | "closed"
  | "expired"
  | "wrong-workspace"
  | "over-limit";

export type CardDecision =
  | { readonly ok: true; readonly card: VirtualCard }
  | { readonly ok: false; readonly reason: CardDenialReason };

export interface UseCardOptions {
  readonly workspaceId: string;
  /** The purchase about to be made, re-hashed at the moment of use. */
  readonly payload: PurchasePayload;
  readonly now: number;
}

/**
 * Check a card against the purchase it is about to pay for.
 *
 * This runs immediately before the charge, and it is deliberately a second
 * check of something the spend gate already verified. The gate checks a token
 * against a payload; this checks a *card* against a payload. They can disagree
 * only if something has gone wrong between them, which is exactly the moment
 * worth catching.
 */
export function authorizeCard(card: VirtualCard, options: UseCardOptions): CardDecision {
  if (card.workspaceId !== options.workspaceId) {
    return { ok: false, reason: "wrong-workspace" };
  }
  if (card.state === "used") return { ok: false, reason: "already-used" };
  if (card.state === "closed") return { ok: false, reason: "closed" };
  if (card.state === "expired" || options.now >= card.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (card.payloadHash !== payloadHash(options.payload)) {
    return { ok: false, reason: "wrong-purchase" };
  }
  if (options.payload.totalAmount > card.limitAmount) {
    return { ok: false, reason: "over-limit" };
  }

  return { ok: true, card };
}

/** Record a charge and retire the card in the same step. */
export function markUsed(card: VirtualCard, authorizedAmount: number, now: number): VirtualCard {
  return { ...card, state: "used", authorizedAmount, closedAt: now };
}

export function markClosed(card: VirtualCard, now: number): VirtualCard {
  return card.state === "used" ? card : { ...card, state: "closed", closedAt: now };
}

/**
 * Close everything that should no longer be live.
 *
 * A task that crashed between issuing and charging leaves a card behind, and an
 * issuer holding a thousand forgotten open cards has recreated the stored-card
 * problem virtual cards exist to solve. Returns what it closed so the caller can
 * meter it — a rising number here means tasks are dying mid-checkout.
 */
export async function sweepExpired(
  issuer: CardIssuer,
  cards: readonly VirtualCard[],
  now: number
): Promise<readonly VirtualCard[]> {
  const stale = cards.filter((card) => card.state === "issued" && now >= card.expiresAt);

  const closed: VirtualCard[] = [];
  for (const card of stale) {
    try {
      await issuer.close(card.id);
      closed.push({ ...card, state: "expired", closedAt: now });
    } catch {
      // Left open deliberately rather than marked closed on a failed call. A
      // card recorded as closed that is actually live is worse than one known
      // to be outstanding, because nothing will try again.
    }
  }

  return closed;
}

export function explainCardDenial(reason: CardDenialReason): string {
  switch (reason) {
    case "wrong-purchase":
      return "The purchase changed after this card was issued, so I stopped. I can ask you to approve the new amount.";
    case "already-used":
      return "That card has already been used.";
    case "closed":
      return "That card was closed.";
    case "expired":
      return "That card expired before checkout finished — I can start again.";
    case "wrong-workspace":
      return "That card is not valid.";
    case "over-limit":
      return "The total is higher than what you approved, so the card will not cover it.";
  }
}

/**
 * What the user is told about the card backing a purchase.
 *
 * The tolerance is stated. A user who approved £96 and later sees a £98 charge
 * should have been told the card would allow a little over, rather than
 * discovering the gap on a statement.
 */
export function describeCard(card: VirtualCard): string {
  const format = (minor: number) => (minor / 100).toFixed(2);
  return (
    `A single-use card for ${card.merchant}, capped at ${format(card.limitAmount)} ` +
    `${card.currency}. It covers a little over the total so a small fee or exchange-rate ` +
    `movement does not decline, and it closes as soon as it is charged.`
  );
}
