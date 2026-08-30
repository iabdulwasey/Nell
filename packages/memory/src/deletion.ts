/**
 * Deletion, with receipts.
 *
 * The specific failure this answers: a shipped personal agent kept ingesting a
 * user's mail after they revoked access, because disconnecting an integration
 * stopped the sync but never removed what had already been indexed. The user
 * found their email still searchable and had to email support to get it out.
 *
 * Here, revoke means delete. Disconnecting runs a deletion pass over everything
 * derived from that source, and issues a receipt the user can keep: what was
 * removed, how much, and when. A claim you cannot show is not a guarantee.
 *
 * Derived data is *rebuildable*, which is what makes this honest — we can drop
 * an index entirely because it can be regenerated from source if the user ever
 * reconnects. Nothing needs to be kept "just in case".
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const deletionScopeSchema = z.enum([
  /** Everything derived from one connected integration. */
  "integration",
  /** Facts and rules the agent learned. */
  "memory",
  /** The record of tasks performed. */
  "history",
  /** Everything: account closure. */
  "account",
]);

export type DeletionScope = z.infer<typeof deletionScopeSchema>;

/** One class of data removed, counted. */
export interface DeletedCategory {
  readonly category: string;
  readonly count: number;
  /** True when this data can be regenerated from source if reconnected. */
  readonly rebuildable: boolean;
}

export interface DeletionRequest {
  readonly workspaceId: string;
  readonly scope: DeletionScope;
  /** Which integration, when scope is "integration". */
  readonly source?: string;
  readonly requestedAt: number;
}

export interface DeletionReceipt {
  readonly id: string;
  readonly workspaceId: string;
  readonly scope: DeletionScope;
  readonly source?: string;
  readonly categories: readonly DeletedCategory[];
  readonly totalRecords: number;
  readonly requestedAt: number;
  readonly completedAt: number;
  /**
   * Digest over the receipt's contents. Lets the user verify later that the
   * receipt they hold is the one we issued, unaltered.
   */
  readonly digest: string;
}

export function receiptDigest(receipt: Omit<DeletionReceipt, "digest" | "id">): string {
  const canonical = JSON.stringify({
    categories: [...receipt.categories].map((c) => `${c.category}:${String(c.count)}`).sort(),
    completedAt: receipt.completedAt,
    requestedAt: receipt.requestedAt,
    scope: receipt.scope,
    source: receipt.source ?? "",
    totalRecords: receipt.totalRecords,
    workspaceId: receipt.workspaceId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function issueReceipt(
  id: string,
  request: DeletionRequest,
  categories: readonly DeletedCategory[],
  completedAt: number
): DeletionReceipt {
  const totalRecords = categories.reduce((sum, category) => sum + category.count, 0);
  const base = {
    workspaceId: request.workspaceId,
    scope: request.scope,
    source: request.source,
    categories,
    totalRecords,
    requestedAt: request.requestedAt,
    completedAt,
  };
  return { id, ...base, digest: receiptDigest(base) };
}

/** Verify a receipt has not been altered since it was issued. */
export function verifyReceipt(receipt: DeletionReceipt): boolean {
  const { digest, id: _id, ...rest } = receipt;
  return receiptDigest(rest) === digest;
}

/**
 * What a given scope must remove.
 *
 * Kept as an explicit list rather than inferred, so adding a new store forces a
 * decision about what deletion means for it. A store that is silently forgotten
 * here is exactly how "we deleted it" becomes untrue.
 */
export const SCOPE_CATEGORIES: Readonly<Record<DeletionScope, readonly string[]>> = {
  integration: ["synced-content", "derived-index", "extraction-cache"],
  /** What the agent learned: stated facts, standing rules, and free-form notes. */
  memory: ["preferences", "directives", "brain-cache", "notes"],
  /** What it did, and what was said while doing it. */
  history: ["task-ledger", "monitor-reports", "messages", "approvals"],
  account: [
    "synced-content",
    "derived-index",
    "extraction-cache",
    "preferences",
    "directives",
    "brain-cache",
    "notes",
    "task-ledger",
    "monitor-reports",
    "messages",
    "approvals",
    "vault-items",
    "vault-secrets",
    "monitors",
    "tasks",
    "notification-outbox",
    "provider-keys",
    "model-choice",
    "membership",
  ],
};

/**
 * Tenant data this deployment holds that no scope removes — with the reason.
 *
 * The audit log is the only entry and the reason is in `NEVER_DELETED` below.
 * The list exists so that "not deleted" has to be a **decision somebody wrote
 * down**, rather than a table nobody remembered.
 *
 * The hole this closes was real and was mine. `/delete account` said
 * *everything* and left behind the conversation, every free-form note, and —
 * added the same day the scope was not updated — the workspace's **encrypted
 * API keys**. A deletion feature that misses a table is not a smaller feature;
 * it is a false claim, and this one's entire pitch is that the claim is true.
 */
export const DELIBERATELY_KEPT: Readonly<Record<string, string>> = {
  "audit-log":
    "Records that actions happened, not what they were about — including that " +
    "this deletion happened. Removing it destroys the user's own evidence.",
};

/** Categories that are regenerable from source rather than user-authored. */
const REBUILDABLE = new Set(["derived-index", "extraction-cache", "brain-cache"]);

export function isRebuildable(category: string): boolean {
  return REBUILDABLE.has(category);
}

/**
 * The audit log is deliberately absent from every scope.
 *
 * It records that actions happened, not the content of what was acted on, and
 * removing it would destroy the user's own evidence trail — including the proof
 * that this deletion occurred. Subject references are pseudonymised instead, so
 * the chain stays verifiable while the identifier becomes unrecoverable.
 */
export const NEVER_DELETED = ["audit-log"] as const;

export function plan(scope: DeletionScope): readonly string[] {
  return SCOPE_CATEGORIES[scope];
}
