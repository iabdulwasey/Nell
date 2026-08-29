/**
 * The two memory tables nothing was writing to.
 *
 * `task_ledger` has existed since the first migration and `directives` was added
 * the moment this file needed it. Between them they are what `TASKS.md` and
 * `USER.md` are rendered from — so until now those documents could only ever
 * have come out empty, which is why nobody noticed they were unreachable.
 *
 * The split between the three memory kinds is worth restating because it decides
 * what goes where, and getting it wrong is how an agent ends up obeying a
 * passing remark:
 *
 *   preferences  what Nell *knows*      — where you live, which airline you like
 *   directives   what Nell must *do*    — always ask before spending over £50
 *   the ledger   what Nell *did*        — booked BA117, £612, succeeded
 *
 * A missed fact prompts a question. A missed directive breaks a promise. A
 * missed ledger entry means "same as last time" has nothing to point at.
 */

import {
  addDirective,
  directiveKindSchema,
  liveDirectives,
  recordTask,
  taskOutcomeSchema,
  type Directive,
  type LedgerEntry,
  type TaskOutcome,
} from "@nell/memory";
import type { AccessScope } from "@nell/shared";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

const ledgerRow = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  task_id: z.string().nullish(),
  objective: z.string(),
  outcome: z.string(),
  merchant: z.string().nullish(),
  amount: z.number().nullish(),
  currency: z.string().nullish(),
  /**
   * Coerced to strings on the way out, matching `LedgerEntry`.
   *
   * `sanitizeDetail` already flattens this on the way in, so a value that is
   * not a string means the row predates that or was written by hand. Coercing
   * is right where dropping is not: a detail nobody can read is still evidence
   * of what happened.
   */
  detail: z
    .record(z.string(), z.unknown())
    .default({})
    .transform((value) =>
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
    ),
  completed_at: z.date(),
});

export interface RecordTaskInput {
  readonly taskId: string;
  readonly objective: string;
  readonly outcome: TaskOutcome;
  readonly merchant?: string;
  readonly amount?: number;
  readonly currency?: string;
}

/**
 * Write down what a task did.
 *
 * Built through `recordTask` rather than assembled here, because that is where
 * the objective is truncated and the detail sanitised — a ledger entry is a
 * durable record, and the one thing it must never quietly acquire is a secret
 * that came back in a task's payload.
 */
export async function recordOutcome(
  client: PoolClient,
  scope: AccessScope,
  input: RecordTaskInput
): Promise<void> {
  const entry = recordTask({
    id: randomUUID(),
    workspaceId: scope.workspaceId,
    taskId: input.taskId,
    objective: input.objective,
    outcome: input.outcome,
    ...(input.merchant ? { merchant: input.merchant } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.currency ? { currency: input.currency } : {}),
    now: Date.now(),
  });

  await client.query(
    `INSERT INTO task_ledger
       (workspace_id, task_id, objective, merchant, outcome, amount, currency, detail, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, to_timestamp($9 / 1000.0))`,
    [
      entry.workspaceId,
      entry.taskId,
      entry.objective,
      entry.merchant ?? null,
      entry.outcome,
      entry.amount ?? null,
      entry.currency ?? null,
      JSON.stringify(entry.detail),
      entry.completedAt,
    ]
  );
}

/** What has been done before. Newest first, bounded — this is context, not an archive. */
export async function readLedger(
  client: PoolClient,
  scope: AccessScope,
  limit = 50
): Promise<readonly LedgerEntry[]> {
  const { rows } = await client.query(
    `SELECT id, task_id, objective, outcome, merchant, amount, currency, detail, completed_at
       FROM task_ledger WHERE workspace_id = $1
      ORDER BY completed_at DESC LIMIT $2`,
    [scope.workspaceId, limit]
  );

  return rows
    .map((row) => ledgerRow.safeParse(row))
    .filter((parsed) => parsed.success)
    .map(({ data }) => {
      const outcome = taskOutcomeSchema.safeParse(data.outcome);
      return {
        id: data.id,
        workspaceId: scope.workspaceId,
        taskId: data.task_id ?? "",
        objective: data.objective,
        // A row whose outcome the enum no longer recognises is reported as
        // failed rather than dropped: a task that happened is still a fact.
        outcome: outcome.success ? outcome.data : ("failed" as const),
        ...(data.merchant ? { merchant: data.merchant } : {}),
        ...(data.amount !== null && data.amount !== undefined ? { amount: data.amount } : {}),
        ...(data.currency ? { currency: data.currency } : {}),
        detail: data.detail,
        completedAt: data.completed_at.getTime(),
      } satisfies LedgerEntry;
    });
}

const directiveRow = z.object({
  id: z.string(),
  kind: z.string(),
  rule: z.string(),
  provenance: z.string(),
  created_at: z.date(),
  revoked_at: z.date().nullish(),
});

export async function readDirectives(
  client: PoolClient,
  scope: AccessScope
): Promise<readonly Directive[]> {
  const { rows } = await client.query(
    `SELECT id, kind, rule, provenance, created_at, revoked_at
       FROM directives WHERE workspace_id = $1 ORDER BY created_at`,
    [scope.workspaceId]
  );

  return rows
    .map((row) => directiveRow.safeParse(row))
    .filter((parsed) => parsed.success)
    .map(({ data }) => {
      const kind = directiveKindSchema.safeParse(data.kind);
      return {
        id: data.id,
        workspaceId: scope.workspaceId,
        kind: kind.success ? kind.data : ("preference" as Directive["kind"]),
        rule: data.rule,
        provenance: data.provenance as Directive["provenance"],
        createdAt: data.created_at.getTime(),
        ...(data.revoked_at ? { revokedAt: data.revoked_at.getTime() } : {}),
      } satisfies Directive;
    });
}

export type AddDirectiveOutcome =
  | { readonly ok: true; readonly directive: Directive }
  | { readonly ok: false; readonly reason: string };

/**
 * Add a standing rule.
 *
 * Runs through `addDirective`, which is where the gate lives: **an untrusted
 * source can never plant one.** That matters more here than anywhere else in
 * memory — a directive is the strongest standing instruction the system has, and
 * a web page that could write one would not need to win an argument ever again.
 */
export async function addRule(
  client: PoolClient,
  scope: AccessScope,
  input: {
    readonly kind: string;
    readonly rule: string;
    readonly provenance: Directive["provenance"];
  }
): Promise<AddDirectiveOutcome> {
  const kind = directiveKindSchema.safeParse(input.kind);
  if (!kind.success) return { ok: false, reason: `Unknown kind of rule: ${input.kind}` };

  const existing = await readDirectives(client, scope);
  const id = randomUUID();
  const result = addDirective({
    id,
    workspaceId: scope.workspaceId,
    kind: kind.data,
    rule: input.rule,
    provenance: input.provenance,
    existing,
    now: Date.now(),
  });

  if (!result.ok) return { ok: false, reason: explainRejection(result.reason) };

  /**
   * `addDirective` returns the whole updated list rather than the one row, so
   * the new one is found by the id we generated. Taking `.at(-1)` would work
   * today and break the day the function starts ordering by anything.
   */
  const added = result.directives.find((directive) => directive.id === id);
  if (!added) return { ok: false, reason: "I couldn't save that rule." };

  await client.query(
    `INSERT INTO directives (id, workspace_id, kind, rule, provenance, created_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
    [added.id, scope.workspaceId, added.kind, added.rule, added.provenance, added.createdAt]
  );

  return { ok: true, directive: added };
}

/** Revoked rather than deleted, so "you told me to stop on the 4th" stays answerable. */
export async function revokeRule(
  client: PoolClient,
  scope: AccessScope,
  id: string
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE directives SET revoked_at = now()
      WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [scope.workspaceId, id]
  );
  return (rowCount ?? 0) > 0;
}

/** Rules currently in force, which is what gets rendered and obeyed. */
export async function liveRules(
  client: PoolClient,
  scope: AccessScope
): Promise<readonly Directive[]> {
  return liveDirectives(await readDirectives(client, scope), scope.workspaceId);
}

function explainRejection(reason: string): string {
  switch (reason) {
    case "untrusted-provenance":
      return "A rule can only come from you, never from something I read.";
    case "empty-rule":
      return "That rule was empty.";
    case "rule-too-long":
      return "That rule is too long to keep — shorten it to one sentence.";
    case "duplicate":
      return "I already have that rule.";
    default:
      return "I couldn't save that rule.";
  }
}
