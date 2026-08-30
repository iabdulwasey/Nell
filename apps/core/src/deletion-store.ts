/**
 * Actually deleting it, and proving what went.
 *
 * `@nell/memory` has had the whole apparatus since v1 — scopes, the categories
 * each removes, a digest-verifiable receipt, the classification of what is
 * rebuildable and the deliberate exclusion of the audit log. **Nothing ever
 * called it.** So "hard-delete with deletion receipts" sat in the trust pitch as
 * a design somebody had thought about carefully, which is the difference between
 * a promise and a feature.
 *
 * The reason this is more than a `DELETE` loop is the receipt, and the reason
 * the receipt is more than decoration is that it counts **what was actually
 * removed** rather than what the plan said would be. A receipt built from
 * `SCOPE_CATEGORIES` would be a document asserting a deletion happened, produced
 * without checking — the exact shape of the thing this feature exists to
 * disprove about a competitor. Every count here is a `rowCount` from the
 * statement that did the work.
 *
 * **The audit log survives every scope, on purpose.** It records that actions
 * happened, not the content of what was acted on, and destroying it would take
 * the user's own evidence with it — including the proof that this deletion
 * occurred. A deletion feature that erased the record of deletions would be
 * indistinguishable from one that never ran.
 */

import {
  DELIBERATELY_KEPT,
  isRebuildable,
  issueReceipt,
  plan,
  type DeletedCategory,
  type DeletionReceipt,
  type DeletionScope,
} from "@nell/memory";
import type { AccessScope } from "@nell/shared";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * Which table each category lives in.
 *
 * Explicit rather than derived, for the reason `SCOPE_CATEGORIES` is: a store
 * added next month is forgotten silently unless something forces a decision
 * about what deletion means for it. A category with no table here deletes
 * nothing and says so in the receipt as a zero, which is honest — where quietly
 * omitting the row would let the total look complete.
 */
const TABLES: Readonly<Record<string, string | undefined>> = {
  preferences: "preferences",
  directives: "directives",
  "task-ledger": "task_ledger",
  "monitor-reports": "monitor_reports",
  monitors: "monitors",
  tasks: "tasks",
  "vault-items": "vault_items",
  "vault-secrets": "vault_secrets",
  /** Everything `/remember` wrote — plainly memory, and missed for months. */
  notes: "notes",
  /** The conversation itself. */
  messages: "messages",
  approvals: "approvals",
  "notification-outbox": "notification_outbox",
  /**
   * The workspace's own API keys, added the same day the deletion scope was not
   * updated to include them — so account closure would have left an encrypted
   * vendor credential behind while handing back a receipt saying everything had
   * gone.
   */
  "provider-keys": "workspace_keys",
  "model-choice": "workspace_models",
  /**
   * Membership. Account closure means the account is gone, so the row that says
   * this person owns this workspace goes with it.
   */
  membership: "workspace_members",
  /**
   * The brain document is rendered on demand from the rows above, so there is
   * nothing of its own to remove — deleting the sources *is* deleting it. Named
   * here rather than omitted so the receipt can say so out loud.
   */
  "brain-cache": undefined,
  /** Nothing syncs yet: no integration is connected, so no content was stored. */
  "synced-content": undefined,
  "extraction-cache": undefined,
  /**
   * The recall index is built per query from live sources and never stored, so
   * there is nothing of its own to delete — removing the sources *is* removing
   * it. Named rather than omitted so the receipt says so out loud.
   */
  "derived-index": undefined,
};

export interface DeletionOutcome {
  readonly receipt: DeletionReceipt;
  /** Categories the scope names that this deployment stores nothing for. */
  readonly empty: readonly string[];
}

/**
 * Delete everything in a scope, and issue a receipt for what went.
 *
 * One transaction, because a partial deletion with a receipt claiming a whole
 * one is worse than a failure: the user would have a signed document saying
 * their data is gone while some of it remains.
 */
export async function deleteScope(
  client: PoolClient,
  scope: AccessScope,
  what: DeletionScope,
  requestedAt: number,
  now: number = Date.now()
): Promise<DeletionOutcome> {
  const categories: DeletedCategory[] = [];
  const empty: string[] = [];

  await client.query("BEGIN");
  try {
    for (const category of plan(what)) {
      const table = TABLES[category];
      if (!table) {
        empty.push(category);
        continue;
      }

      /**
       * The count comes from the delete itself.
       *
       * Not a `SELECT count(*)` beforehand — between the two statements the
       * number can change, and a receipt is a claim about what this operation
       * did rather than about what was there a moment earlier.
       */
      const { rowCount } = await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [
        scope.workspaceId,
      ]);

      categories.push({
        category,
        count: rowCount ?? 0,
        rebuildable: isRebuildable(category),
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    receipt: issueReceipt(
      randomUUID(),
      { workspaceId: scope.workspaceId, scope: what, requestedAt },
      categories,
      now
    ),
    empty,
  };
}

/**
 * The receipt as something a person can read and check later.
 *
 * The digest is shown rather than hidden, because a receipt nobody can verify is
 * a paragraph of reassurance. It is short enough to keep and specific enough to
 * be worth keeping.
 */
export function renderReceipt(outcome: DeletionOutcome): string {
  const { receipt } = outcome;
  const removed = receipt.categories.filter((entry) => entry.count > 0);

  const lines = [
    `Deleted — ${String(receipt.totalRecords)} record${receipt.totalRecords === 1 ? "" : "s"}.`,
    "",
  ];

  if (removed.length === 0) {
    lines.push("There was nothing stored in that scope.");
  } else {
    for (const entry of removed) {
      lines.push(
        `• ${entry.category}: ${String(entry.count)}${entry.rebuildable ? " (derived — rebuilt from what remains)" : ""}`
      );
    }
  }

  lines.push(
    "",
    // Said plainly rather than buried: somebody deleting their history is
    // entitled to know precisely what was kept and why.
    "Your audit log is kept. It records that things happened, not what they " +
      "were about — including that this deletion happened.",
    "",
    `Receipt ${receipt.id.slice(0, 8)} · digest ${receipt.digest.slice(0, 16)}`
  );

  return lines.join("\n");
}

/**
 * Every tenant table, from the database rather than from a list.
 *
 * The same rewrite the RLS gate needed and for the same reason. That check once
 * carried its own hand-maintained copy of the tenant tables, drifted to eleven
 * against thirteen, and would have reported "verified" while a new table sat
 * with no policy. Two hand-maintained lists of the same thing always drift; the
 * fix is to stop keeping the second one and ask the database.
 *
 * Asked here so that a table added next month by somebody who never opens this
 * file forces a decision: it is deleted by a scope, or it is named in
 * `DELIBERATELY_KEPT` with a reason. Silence is the one option removed.
 *
 * `workspaces` is correctly absent — it has `id`, not `workspace_id`, because it
 * *defines* tenants rather than belonging to one.
 */
export async function tenantTables(client: PoolClient): Promise<readonly string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'workspace_id' AND table_schema = 'public'
      ORDER BY table_name`
  );
  return rows.map((row) => row.table_name);
}

/**
 * Tables that account closure would leave behind.
 *
 * Empty is the only acceptable answer, and it was not empty: the conversation,
 * every free-form note, and the workspace's encrypted API keys all survived a
 * deletion that reported success. A deletion feature that misses a table is not
 * a smaller feature — it is a false claim, and this one's whole pitch is that
 * the claim is true.
 */
export function uncovered(tables: readonly string[]): readonly string[] {
  const removed = new Set(
    plan("account")
      .map((category) => TABLES[category])
      .filter((table): table is string => table !== undefined)
  );
  const kept = new Set(
    Object.keys(DELIBERATELY_KEPT).map(
      (category) => TABLES[category] ?? category.replace(/-/gu, "_")
    )
  );

  return tables.filter((table) => !removed.has(table) && !kept.has(table));
}
