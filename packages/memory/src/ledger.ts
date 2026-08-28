/**
 * Tier 2 — the episodic task ledger.
 *
 * One durable record per completed task: what was asked, where it happened, what
 * it cost, what was approved, and how it ended. This is the substrate for "book
 * it like last time" — the agent can look up the previous booking rather than
 * re-interviewing the user — and it doubles as the receipt surface and the
 * user-visible history.
 *
 * Entries are facts about what happened, so unlike preferences they are never
 * rewritten. A task that went wrong stays in the record.
 */

import { z } from "zod";

export const taskOutcomeSchema = z.enum(["succeeded", "failed", "cancelled", "blocked-on-user"]);

export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;

export interface LedgerEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  /** What the user actually asked for, in their words where possible. */
  readonly objective: string;
  readonly outcome: TaskOutcome;
  readonly merchant?: string;
  /** Minor units, so money is never a float. */
  readonly amount?: number;
  readonly currency?: string;
  /** Hash of the approved payload, tying this entry to an approval record. */
  readonly approvalHash?: string;
  /** Structured detail: confirmation numbers, seats, dates. Never secrets. */
  readonly detail: Readonly<Record<string, string>>;
  readonly completedAt: number;
}

export interface RecordOptions {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly objective: string;
  readonly outcome: TaskOutcome;
  readonly merchant?: string;
  readonly amount?: number;
  readonly currency?: string;
  readonly approvalHash?: string;
  readonly detail?: Record<string, string>;
  readonly now: number;
}

/** Keys that must never be persisted into the ledger, even by mistake. */
const FORBIDDEN_DETAIL_KEYS = ["password", "secret", "token", "cvc", "cvv", "card", "pan", "ssn"];

/**
 * Strip anything that looks like a credential. The ledger is shown to the user
 * and used to build prompts, so a stray secret here would defeat the vault.
 */
export function sanitizeDetail(detail: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(detail)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_DETAIL_KEYS.some((forbidden) => lowered.includes(forbidden))) continue;
    clean[key] = value.slice(0, 500);
  }
  return clean;
}

export function recordTask(options: RecordOptions): LedgerEntry {
  return {
    id: options.id,
    workspaceId: options.workspaceId,
    taskId: options.taskId,
    objective: options.objective.slice(0, 1000),
    outcome: options.outcome,
    merchant: options.merchant,
    amount: options.amount,
    currency: options.currency,
    approvalHash: options.approvalHash,
    detail: sanitizeDetail(options.detail ?? {}),
    completedAt: options.now,
  };
}

export interface RecallQuery {
  readonly workspaceId: string;
  readonly merchant?: string;
  /** Case-insensitive substring over the objective. */
  readonly like?: string;
  readonly outcome?: TaskOutcome;
  readonly limit?: number;
}

/**
 * Look up prior tasks, newest first. Deliberately simple matching: the point is
 * to hand the coordinator a couple of relevant precedents, not to be a search
 * engine. The semantic index (tier 4) is where fuzzy recall belongs.
 */
export function recall(
  entries: readonly LedgerEntry[],
  query: RecallQuery
): readonly LedgerEntry[] {
  const like = query.like?.toLowerCase();
  return entries
    .filter((entry) => {
      if (entry.workspaceId !== query.workspaceId) return false;
      if (query.merchant && entry.merchant !== query.merchant) return false;
      if (query.outcome && entry.outcome !== query.outcome) return false;
      if (like && !entry.objective.toLowerCase().includes(like)) return false;
      return true;
    })
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, query.limit ?? 5);
}

/** The most recent successful task at a merchant — the "like last time" lookup. */
export function lastSuccessAt(
  entries: readonly LedgerEntry[],
  workspaceId: string,
  merchant: string
): LedgerEntry | undefined {
  return recall(entries, { workspaceId, merchant, outcome: "succeeded", limit: 1 })[0];
}

/** Render precedents for a worker briefing. Compact by design. */
export function renderPrecedents(entries: readonly LedgerEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => {
      const money =
        entry.amount !== undefined && entry.currency
          ? ` (${entry.currency} ${(entry.amount / 100).toFixed(2)})`
          : "";
      const where = entry.merchant ? ` at ${entry.merchant}` : "";
      const detail = Object.entries(entry.detail)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      return `- ${entry.objective}${where}${money}: ${entry.outcome}${detail ? ` [${detail}]` : ""}`;
    })
    .join("\n");
}
