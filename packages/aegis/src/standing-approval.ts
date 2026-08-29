/**
 * Standing approvals, for things that happen faster than a person can answer.
 *
 * A ticket drop lasts seconds. By the time a push notification has arrived, been
 * read, and been tapped, the tickets are gone — which is how a shipped agent
 * lost a drop to a human and reported it as a crash. The fix is not a faster
 * browser; it is having already decided.
 *
 * That sits directly against the rule the rest of this package is built on: an
 * approval is bound to an exact payload, and anything that changes invalidates
 * it. Pre-authorising a purchase whose price and quantity are not yet known is
 * precisely the thing that rule exists to prevent, and pretending otherwise
 * would be the most dangerous kind of convenience.
 *
 * So this is deliberately a *weaker* instrument, and the weakness is the design
 * rather than a shortcoming to be papered over:
 *
 * - It approves an **envelope**, not a payload: one merchant, one named thing, a
 *   maximum unit price, a maximum quantity, and a total ceiling. A purchase must
 *   fall inside all of them.
 * - It **expires quickly**, in hours rather than the days a standing instruction
 *   invites. A user who said yes to a drop on Friday has not said yes to a drop
 *   next month.
 * - It is **single-use**. It buys the thing once and is spent, so a retry loop
 *   or a duplicated webhook cannot buy four.
 * - It is **revocable**, and revoking is instant.
 *
 * The envelope is what the user is shown and what they agree to, in those terms:
 * "up to two tickets, up to £120 each, up to £250 in total, before Friday
 * evening" is a sentence someone can actually evaluate. "Buy the tickets when
 * they appear" is not.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PurchasePayload } from "./spend.js";

/**
 * The bounds a purchase must fall inside.
 *
 * Every field is a maximum. There is no field a merchant could raise, and no
 * field the agent can widen at the moment of purchase.
 */
export const envelopeSchema = z.object({
  merchant: z.string().min(1).max(200),
  /** What is being bought, in the user's words. Shown back to them verbatim. */
  description: z.string().min(1).max(300),
  maxUnitAmount: z.number().int().positive(),
  maxQuantity: z.number().int().positive().max(20),
  maxTotalAmount: z.number().int().positive(),
  currency: z.string().length(3).toUpperCase(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Twelve hours. Long enough to cover a drop announced this morning, short enough
 * that a forgotten approval is not still live next week.
 */
export const STANDING_APPROVAL_TTL_MS = 12 * 60 * 60 * 1000;

/** Nothing standing may be worth more than this, whatever the user types. */
export const STANDING_CEILING = 100_000;

/**
 * How far above the item prices a total ceiling may sit.
 *
 * Fees on a ticket are routinely fifteen to twenty percent, so headroom is
 * necessary. Half again is generous enough to cover any honest booking fee and
 * tight enough that the ceiling still means something.
 */
export const MAX_FEE_HEADROOM = 1.5;

export interface StandingApproval {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly envelope: Envelope;
  readonly tokenHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly spentAt?: number;
  readonly revokedAt?: number;
}

export interface MintStandingOptions {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly envelope: Envelope;
  readonly pepper: string;
  readonly now: number;
  readonly ttlMs?: number;
  readonly id?: string;
}

export type MintStandingOutcome =
  | { readonly ok: true; readonly approval: StandingApproval; readonly token: string }
  | { readonly ok: false; readonly reason: string };

export function hashStandingToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

/**
 * Mint a standing approval.
 *
 * Refuses an envelope whose own arithmetic does not hold, in either direction: a
 * ceiling that cannot buy even one, or one so far above the item prices that it
 * is not really a limit. Both mean the user's sentence and the machine's bounds
 * have come apart, and the bounds are the only part that gets enforced.
 */
export function mintStandingApproval(options: MintStandingOptions): MintStandingOutcome {
  const parsed = envelopeSchema.safeParse(options.envelope);
  if (!parsed.success) {
    return { ok: false, reason: "That does not describe a purchase I can bound." };
  }

  const envelope = parsed.data;

  if (envelope.maxTotalAmount > STANDING_CEILING) {
    return {
      ok: false,
      reason: "That is more than I will agree to in advance. Ask me at the time instead.",
    };
  }
  // A total below the price of a single unit can never buy anything, which
  // means the user has agreed to something that cannot happen.
  if (envelope.maxTotalAmount < envelope.maxUnitAmount) {
    return {
      ok: false,
      reason: "The total limit is below the price of one, so nothing could ever be bought.",
    };
  }

  // A total ABOVE unit x quantity is normal and expected — it is headroom for
  // the booking fee, which is exactly how someone thinks about a ticket price.
  // What is not normal is headroom so large that the total stops bounding
  // anything: "two at 120" with a 10,000 ceiling is not a limit, it is a number
  // in the same sentence as one.
  const parts = envelope.maxUnitAmount * envelope.maxQuantity;
  if (envelope.maxTotalAmount > Math.ceil(parts * MAX_FEE_HEADROOM)) {
    return {
      ok: false,
      reason:
        "The total limit is far above what the items could cost, so it would not really be limiting anything. Lower it to something close to the real price.",
    };
  }

  const token = randomBytes(32).toString("base64url");

  return {
    ok: true,
    token,
    approval: {
      id: options.id ?? randomBytes(8).toString("hex"),
      workspaceId: options.workspaceId,
      taskId: options.taskId,
      envelope,
      tokenHash: hashStandingToken(token, options.pepper),
      issuedAt: options.now,
      expiresAt: options.now + (options.ttlMs ?? STANDING_APPROVAL_TTL_MS),
    },
  };
}

export type StandingDenial =
  | "no-approval"
  | "unknown-token"
  | "expired"
  | "already-spent"
  | "revoked"
  | "wrong-workspace"
  | "wrong-merchant"
  | "unit-too-expensive"
  | "too-many"
  | "over-total";

export type StandingDecision =
  | { readonly ok: true; readonly approval: StandingApproval }
  | { readonly ok: false; readonly reason: StandingDenial };

export interface AuthorizeStandingOptions {
  readonly token: string;
  readonly workspaceId: string;
  readonly payload: PurchasePayload;
  readonly pepper: string;
  readonly now: number;
}

/**
 * Check a real purchase against a standing envelope.
 *
 * Every bound is checked separately and named separately in the refusal, because
 * "that is outside what you approved" leaves a user unable to tell whether the
 * price moved, the quantity was wrong, or the seller was not who they expected —
 * and those call for different responses.
 */
export function authorizeStanding(
  candidates: readonly StandingApproval[],
  options: AuthorizeStandingOptions
): StandingDecision {
  if (candidates.length === 0) return { ok: false, reason: "no-approval" };

  const presented = hashStandingToken(options.token, options.pepper);
  const approval = candidates.find((candidate) =>
    constantTimeEquals(candidate.tokenHash, presented)
  );

  if (!approval) return { ok: false, reason: "unknown-token" };
  if (approval.revokedAt !== undefined) return { ok: false, reason: "revoked" };
  if (approval.spentAt !== undefined) return { ok: false, reason: "already-spent" };
  if (options.now >= approval.expiresAt) return { ok: false, reason: "expired" };
  if (approval.workspaceId !== options.workspaceId) {
    return { ok: false, reason: "wrong-workspace" };
  }

  const { envelope } = approval;
  const { payload } = options;

  if (payload.merchant !== envelope.merchant) {
    return { ok: false, reason: "wrong-merchant" };
  }

  const quantity = payload.items.reduce((sum, item) => sum + item.quantity, 0);
  if (quantity > envelope.maxQuantity) return { ok: false, reason: "too-many" };

  const dearest = Math.max(...payload.items.map((item) => item.unitAmount));
  if (dearest > envelope.maxUnitAmount) return { ok: false, reason: "unit-too-expensive" };

  // Checked last and independently: unit price and quantity can both be inside
  // their bounds while the total is not, once fees are added.
  if (payload.totalAmount > envelope.maxTotalAmount) {
    return { ok: false, reason: "over-total" };
  }

  return { ok: true, approval };
}

export function markStandingSpent(approval: StandingApproval, now: number): StandingApproval {
  return { ...approval, spentAt: now };
}

export function revokeStanding(approval: StandingApproval, now: number): StandingApproval {
  return approval.revokedAt === undefined ? { ...approval, revokedAt: now } : approval;
}

/**
 * The sentence the user agrees to.
 *
 * Written as limits rather than as an instruction, because those are different
 * promises. "Buy the tickets when they appear" is not something a person can
 * evaluate; "up to two, up to £120 each, up to £250 in total, expiring this
 * evening" is.
 */
export function describeEnvelope(envelope: Envelope, expiresAt: number, now: number): string {
  const money = (minor: number) => `${(minor / 100).toFixed(2)} ${envelope.currency}`;
  const hours = Math.max(1, Math.round((expiresAt - now) / 3_600_000));

  return (
    `${envelope.description} from ${envelope.merchant}: ` +
    `up to ${String(envelope.maxQuantity)}, ` +
    `up to ${money(envelope.maxUnitAmount)} each, ` +
    `up to ${money(envelope.maxTotalAmount)} in total. ` +
    `I will buy once, within ${String(hours)} hour${hours === 1 ? "" : "s"}, and then stop. ` +
    `You can cancel this at any time.`
  );
}

export function explainStandingDenial(reason: StandingDenial): string {
  switch (reason) {
    case "no-approval":
      return "I do not have permission to buy this without asking.";
    case "unknown-token":
    case "wrong-workspace":
      return "That permission is not valid.";
    case "expired":
      return "That permission expired before anything came up.";
    case "already-spent":
      return "I have already used that permission.";
    case "revoked":
      return "You cancelled that permission.";
    case "wrong-merchant":
      return "That is not the seller you approved.";
    case "unit-too-expensive":
      return "They are more expensive than you agreed to, so I have not bought them.";
    case "too-many":
      return "That is more than you asked for.";
    case "over-total":
      return "The total came out above your limit once fees were added, so I stopped.";
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
