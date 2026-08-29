/**
 * The audit log, finally written to.
 *
 * `@nell/audit` has had a hash-chained, verifiable append since Phase 0, the
 * `audit_log` table has existed with RLS since the first migration, and the
 * executor has called `this.#audit?.record(...)` at every consequential step
 * for just as long. Nothing ever passed it a sink, so every one of those calls
 * was a no-op on `undefined`.
 *
 * That was tolerable while the agent could only read public pages. It stopped
 * being tolerable the moment the vault went live: a password is now decrypted
 * and typed into a page, and until this file existed there was no record that
 * it had happened. A vault with no audit trail is the thing this project exists
 * to be the opposite of.
 *
 * **Two independent guarantees, and it is worth being precise about which is
 * which.**
 *
 * The chain makes tampering *evident*: each entry commits to its own contents
 * and to the previous entry's digest, so editing or removing one breaks every
 * digest after it, and `verifyChain` finds the first break.
 *
 * The database makes tampering *impossible through this connection*, which is
 * the stronger of the two and was already in the schema before anything wrote
 * here: `audit_log` carries a trigger that raises on UPDATE and DELETE, and RLS
 * policies of `USING (false)` for both. So it is not that our code declines to
 * rewrite history — no code holding these credentials can, including a
 * compromised one. Getting past that means getting past Postgres itself.
 *
 * **And the limit worth stating rather than glossing.** These entries are
 * written *after* the effect they describe, because the effect happens on
 * somebody else's website and cannot join our transaction. So a recording that
 * fails leaves an action that happened and no entry for it — and because the
 * next entry simply takes the next sequence number, that gap is invisible to
 * `verifyChain`. Nothing here fixes that; what it does instead is make the
 * failure loud, which is why a failed write is reported rather than swallowed.
 */

import {
  appendEntry,
  auditEntrySchema,
  verifyChain,
  type AuditEntry,
  type AuditInput,
} from "@nell/audit";
import type { AccessScope } from "@nell/shared";
import type { Pool, PoolClient } from "pg";
import { withWorkspace } from "./db.js";

/** Postgres unique-violation. A racing append, not a broken one. */
const UNIQUE_VIOLATION = "23505";

/**
 * How many times a racing append is retried before giving up.
 *
 * This is the *cross-process* safety net only — appends from within one process
 * are queued rather than raced (see `auditSink`), so reaching even two attempts
 * means another Nell is writing to the same workspace's chain.
 */
const APPEND_ATTEMPTS = 8;

/**
 * Append one entry, chained to whatever is already there. One attempt.
 *
 * **Deliberately not `SELECT … FOR UPDATE`, and the reason is worth keeping.**
 * Locking the tail row is the textbook way to make read-then-write safe, and on
 * this table it silently does nothing: `audit_log` carries an RLS policy of
 * `FOR UPDATE … USING (false)`, and Postgres applies the *update* policy when
 * you lock a row for update. So the lock filters out every row and returns an
 * empty result — not an error, not a warning, just nothing, which is
 * indistinguishable from an empty table.
 *
 * The consequence was worse than a lost lock: with no previous entry found, the
 * chain restarted at sequence 1 on every append. The primary key caught it, but
 * only by accident — without `(workspace_id, sequence)` being unique this would
 * have quietly forked the chain into parallel histories that both verify.
 *
 * So concurrency is handled by that primary key instead, which is the right
 * tool anyway: an append that races loses the insert, and the caller retries
 * against the new tail. There is nothing here to lock — the row it would lock
 * is one nobody is permitted to modify.
 */
export async function recordEntry(
  client: PoolClient,
  scope: AccessScope,
  input: AuditInput
): Promise<AuditEntry> {
  const { rows } = await client.query(
    `SELECT sequence, workspace_id, action, subject, detail, at, previous_digest, digest
       FROM audit_log
      WHERE workspace_id = $1
      ORDER BY sequence DESC
      LIMIT 1`,
    [scope.workspaceId]
  );

  const previous = rows[0] ? toEntry(rows[0]) : undefined;
  const entry = appendEntry(previous, { ...input, workspaceId: scope.workspaceId });

  await client.query(
    `INSERT INTO audit_log
       (sequence, workspace_id, action, subject, detail, at, previous_digest, digest)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
    [
      entry.sequence,
      entry.workspaceId,
      entry.action,
      entry.subject,
      JSON.stringify(entry.detail),
      entry.at,
      entry.previousDigest,
      entry.digest,
    ]
  );

  return entry;
}

/**
 * Append, retrying against the new tail when another append got there first.
 *
 * Each attempt is its own transaction, because a failed statement poisons the
 * one it ran in — a retry inside the same transaction only ever fails again.
 * The heartbeat runs beside the message poll, so two appends genuinely can
 * collide; five attempts is far more than that needs and still terminates.
 */
export async function appendWithRetry(
  pool: Pool,
  scope: AccessScope,
  input: AuditInput
): Promise<AuditEntry> {
  let last: unknown;

  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
    try {
      return await withWorkspace(pool, scope, (client) => recordEntry(client, scope, input));
    } catch (error) {
      // Only a race is retried. Anything else — a dead connection, a bad
      // value — is reported as it is rather than tried four more times.
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      last = error;
    }
  }

  throw last instanceof Error ? last : new Error("Could not append to the audit log.");
}

/**
 * What a caller supplies.
 *
 * The workspace is optional and, when given, ignored: the sink is bound to one
 * chain and `recordEntry` stamps that workspace over whatever arrives. Widening
 * the parameter rather than demanding a value that gets overwritten — a
 * parameter whose value never matters is a parameter somebody will one day set
 * carefully and be surprised by.
 *
 * Wider than `AuditInput`, so this still satisfies the executor's `AuditSink`.
 */
export type AuditRecord = Omit<AuditInput, "workspaceId"> & { readonly workspaceId?: string };

/**
 * The sink the executor holds.
 *
 * Bound to one workspace, because a chain is per-workspace and an executor
 * handling two would interleave them — which `appendEntry` refuses outright
 * rather than silently producing a chain nobody can verify.
 */
export function auditSink(
  pool: Pool,
  scope: AccessScope,
  onError?: (note: string) => void
): { record: (input: AuditRecord) => Promise<void> } {
  /**
   * Appends from this process queue behind one another.
   *
   * A hash chain is a read-then-write on a single tail, so N concurrent writers
   * contend N ways: each round exactly one wins and the rest retry, which needs
   * as many attempts as there are writers. Eight parallel appends duly exhausted
   * five retries and lost an entry — the exact failure this file exists to stop.
   *
   * Retrying harder would have hidden it rather than fixed it. Serialising costs
   * nothing real (an append is one small insert, and they are already rare) and
   * removes self-contention entirely, leaving the retry to do the job it is
   * actually suited to: another process writing to the same chain.
   */
  let queue: Promise<void> = Promise.resolve();

  return {
    record: (input) => {
      // The returned promise is the caller's own place in the queue, so awaiting
      // `record` still means "mine is written", not "mine is scheduled".
      queue = queue.then(() => append(input));
      return queue;
    },
  };

  async function append(input: AuditRecord): Promise<void> {
    try {
      await appendWithRetry(pool, scope, { ...input, workspaceId: scope.workspaceId });
    } catch (error) {
      /**
       * Reported, not swallowed and not rethrown.
       *
       * Rethrowing would fail an action that has already happened — the fill
       * is on the page whether or not we managed to write it down — so the
       * user would be told a task failed that in fact succeeded, with a
       * credential now typed into a form. Swallowing it silently is worse in
       * the other direction. So it goes to the operator's log, loudly, and the
       * limitation is stated in this file's header rather than hidden.
       */
      onError?.(
        `AUDIT WRITE FAILED (${input.action} on ${input.subject}): ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }
  }
}

export interface AuditView {
  readonly entries: readonly AuditEntry[];
  readonly total: number;
  readonly valid: boolean;
  /** Sequence of the first entry that failed, when the chain is broken. */
  readonly brokenAt?: number;
  /** What kind of break it is — edited, removed, reordered. */
  readonly reason?: string;
}

/**
 * Recent entries, and whether the whole chain still verifies.
 *
 * Verification runs over *everything*, not over the page being shown — a chain
 * checked only from where the reader happens to be looking is a chain an
 * attacker breaks by deleting old entries. The listing is trimmed; the check is
 * not.
 */
export async function readAudit(pool: Pool, scope: AccessScope, limit = 20): Promise<AuditView> {
  return withWorkspace(pool, scope, async (client) => {
    const { rows } = await client.query(
      `SELECT sequence, workspace_id, action, subject, detail, at, previous_digest, digest
         FROM audit_log WHERE workspace_id = $1 ORDER BY sequence ASC`,
      [scope.workspaceId]
    );

    const all = rows.map(toEntry);
    const result = verifyChain(all);

    return {
      entries: all.slice(-limit).reverse(),
      total: all.length,
      valid: result.valid,
      ...(result.valid
        ? {}
        : {
            brokenAt: result.brokenAt ?? 0,
            ...(result.reason ? { reason: result.reason } : {}),
          }),
    };
  });
}

/**
 * A stored row, or an exception.
 *
 * Deliberately not `undefined` on failure. `recordEntry` reads the tail to
 * chain from, and there "could not parse this row" and "there is no previous
 * row" are opposite facts that must not share a return value: treating a
 * corrupt tail as the start of a chain restarts the sequence at 1 and forks the
 * history. Throwing turns a corrupt row into a loud failure, which is the only
 * safe direction for a log whose whole purpose is being trustworthy.
 */
function toEntry(row: unknown): AuditEntry {
  const source = row as Record<string, unknown>;
  const at = source["at"];
  const parsed = auditEntrySchema.safeParse({
    sequence: source["sequence"],
    workspaceId: source["workspace_id"],
    action: source["action"],
    subject: source["subject"],
    detail: source["detail"] ?? {},
    // Postgres hands back a Date; the chain digests the RFC 3339 string, so the
    // conversion has to be exactly the one used when it was written.
    at: at instanceof Date ? at.toISOString() : String(at),
    previousDigest: source["previous_digest"],
    digest: source["digest"],
  });
  if (!parsed.success) {
    throw new Error(
      `Audit row ${String(source["sequence"])} could not be read: ${parsed.error.issues[0]?.message ?? "invalid"}`
    );
  }
  return parsed.data;
}
