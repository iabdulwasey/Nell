/**
 * Spend gate.
 *
 * An approval is bound to a hash of the exact purchase payload (merchant, items,
 * quantity, options, total). Confirming mints a single-use, short-TTL token bound
 * to that hash; the purchase call must present a token whose hash matches the
 * live payload. Change the total or the items and the token silently stops
 * matching — re-approval is required.
 *
 * This is the structural fix for "I asked it to FIND a reservation and it BOOKED
 * one with a cancellation fee": finding requires no token, and booking without a
 * matching token is a dispatcher error, not a model that needs scolding.
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const purchasePayloadSchema = z.object({
  merchant: z.string().min(1).max(200),
  /** Line items, order-insensitive for hashing. */
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        quantity: z.number().int().positive(),
        /** Minor units (cents), integers only — never floats for money. */
        unitAmount: z.number().int().nonnegative(),
      })
    )
    .min(1),
  /** Selected options that materially change the order (seat, date, tier). */
  options: z.record(z.string(), z.string()).default({}),
  /** Total in minor units, including fees. */
  totalAmount: z.number().int().nonnegative(),
  currency: z.string().length(3).toUpperCase(),
});

export type PurchasePayload = z.infer<typeof purchasePayloadSchema>;

/**
 * Stable hash of a payload. Items are sorted so an equivalent order in a
 * different sequence yields the same hash; every field that could change what
 * the user actually buys is committed to.
 */
export function payloadHash(payload: PurchasePayload): string {
  const parsed = purchasePayloadSchema.parse(payload);
  const items = [...parsed.items]
    .map((item) => `${item.description}|${String(item.quantity)}|${String(item.unitAmount)}`)
    .sort();
  const options = Object.entries(parsed.options)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);

  return createHash("sha256")
    .update(
      [
        parsed.merchant,
        items.join(";"),
        options.join(";"),
        String(parsed.totalAmount),
        parsed.currency,
      ].join("\u0000")
    )
    .digest("hex");
}

export interface ApprovalToken {
  readonly token: string;
  readonly payloadHash: string;
  readonly workspaceId: string;
  /** Epoch milliseconds after which the token is no longer valid. */
  readonly expiresAt: number;
  readonly spent: boolean;
}

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface MintOptions {
  readonly workspaceId: string;
  readonly payload: PurchasePayload;
  readonly now: number;
  readonly ttlMs?: number;
}

export function mintApproval(options: MintOptions): ApprovalToken {
  return {
    token: randomUUID(),
    payloadHash: payloadHash(options.payload),
    workspaceId: options.workspaceId,
    expiresAt: options.now + (options.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
    spent: false,
  };
}

export type SpendDecision =
  | { readonly allowed: true; readonly token: ApprovalToken }
  | { readonly allowed: false; readonly reason: SpendDenialReason };

export type SpendDenialReason =
  | "no-approval"
  | "payload-changed"
  | "expired"
  | "already-spent"
  | "wrong-workspace"
  | "over-budget";

export interface AuthorizeOptions {
  readonly token: ApprovalToken | undefined;
  readonly workspaceId: string;
  readonly payload: PurchasePayload;
  readonly now: number;
  /** Remaining budget in minor units, when a cap is configured. */
  readonly remainingBudget?: number;
}

/**
 * The gate itself. Returns a decision rather than throwing so the caller can
 * record the denial in the audit log before surfacing it.
 */
export function authorizeSpend(options: AuthorizeOptions): SpendDecision {
  const { token, workspaceId, payload, now } = options;

  if (!token) return { allowed: false, reason: "no-approval" };
  if (token.workspaceId !== workspaceId) {
    return { allowed: false, reason: "wrong-workspace" };
  }
  if (token.spent) return { allowed: false, reason: "already-spent" };
  if (token.expiresAt <= now) return { allowed: false, reason: "expired" };
  if (token.payloadHash !== payloadHash(payload)) {
    return { allowed: false, reason: "payload-changed" };
  }
  if (options.remainingBudget !== undefined && payload.totalAmount > options.remainingBudget) {
    return { allowed: false, reason: "over-budget" };
  }

  return { allowed: true, token: { ...token, spent: true } };
}

/** Human-readable explanation, safe to show the user. */
export function explainDenial(reason: SpendDenialReason): string {
  switch (reason) {
    case "no-approval":
      return "This purchase has not been approved.";
    case "payload-changed":
      return "The order changed since you approved it, so it needs approving again.";
    case "expired":
      return "That approval expired. Please confirm again.";
    case "already-spent":
      return "That approval was already used.";
    case "wrong-workspace":
      return "That approval belongs to a different workspace.";
    case "over-budget":
      return "This purchase would exceed the configured spending limit.";
  }
}
