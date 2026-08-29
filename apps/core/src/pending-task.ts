/**
 * A task waiting on an answer.
 *
 * When Nell needs something only the user can supply — where they are, which of
 * two flights, whether to spend the money — the task does not fail and does not
 * guess. It parks, and the next message that answers the question resumes it.
 *
 * `blocked-on-user` is a status the task registry already models and the
 * dashboard already renders differently from `failed`, for the reason that
 * matters here: blocked is not failed. A task that stopped because it asked a
 * question is one message away from finishing, and reporting it as a failure
 * teaches the user their assistant does not work.
 *
 * One parked task per workspace, deliberately. Two open questions over a single
 * chat thread is the ambiguity `routeMessage` exists to resolve, and building
 * half of that here — guessing which question a bare "Bangalore" answers — is
 * how someone's reply lands on the wrong task. Until routing is wired, a second
 * question replaces the first.
 */

import type { AccessScope } from "@nell/shared";
import type { PoolClient } from "pg";

export interface PendingTask {
  readonly id: string;
  /** The objective to resume, verbatim. */
  readonly objective: string;
  readonly threadRef: string | undefined;
  /**
   * What Nell asked, so the next message can be judged against it.
   *
   * Without this only two answers could ever resume a task — a yes to a payment
   * and a place name — because those were the only two questions the code knew
   * how to recognise. Every other question turned the reply into a new task and
   * left the original blocked for ever.
   */
  readonly question: string | undefined;
}

/**
 * Park a task until the user answers.
 *
 * The objective is stored in `label`, which is what the dashboard shows — so a
 * parked task reads as the thing it is waiting to do rather than as an opaque
 * id. Truncated to the column's width, and that truncation is the reason this
 * only parks objectives short enough to survive it intact.
 */
export async function park(
  client: PoolClient,
  scope: AccessScope,
  input: {
    readonly id: string;
    readonly objective: string;
    readonly threadRef: string;
    /** What was asked. Judged against the next message to decide if it answers. */
    readonly question?: string;
  }
): Promise<void> {
  // A second question replaces the first rather than queueing behind it.
  await client.query(
    `UPDATE tasks SET status = 'cancelled', updated_at = now()
      WHERE workspace_id = $1 AND status = 'blocked-on-user'`,
    [scope.workspaceId]
  );

  await client.query(
    `INSERT INTO tasks (id, workspace_id, label, status, channel_thread_ref, blocked_on, updated_at)
     VALUES ($1, $2, $3, 'blocked-on-user', $4, $5, now())
     ON CONFLICT (id) DO UPDATE
       SET status = 'blocked-on-user', blocked_on = EXCLUDED.blocked_on, updated_at = now()`,
    [
      input.id,
      scope.workspaceId,
      input.objective.slice(0, 120),
      input.threadRef,
      input.question?.slice(0, 500) ?? null,
    ]
  );
}

/**
 * Give up on the parked task because the user went somewhere else.
 *
 * `abandoned`, not `cancelled` and not `failed`. Nobody said stop and nothing
 * broke — they asked about something else and never came back to this, which is
 * an ordinary thing people do and deserves its own word. Reporting it as failed
 * would put a fault in the record that nobody committed.
 */
export async function abandon(
  client: PoolClient,
  scope: AccessScope,
  id: string
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE tasks SET status = 'abandoned', updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND status = 'blocked-on-user'`,
    [scope.workspaceId, id]
  );
  return (rowCount ?? 0) > 0;
}

/** What is waiting, if anything. Does not clear it — the answer might not arrive. */
export async function peek(
  client: PoolClient,
  scope: AccessScope
): Promise<PendingTask | undefined> {
  const { rows } = await client.query<{
    id: string;
    label: string;
    channel_thread_ref: string | null;
    blocked_on: string | null;
  }>(
    `SELECT id, label, channel_thread_ref, blocked_on FROM tasks
      WHERE workspace_id = $1 AND status = 'blocked-on-user'
      ORDER BY updated_at DESC LIMIT 1`,
    [scope.workspaceId]
  );

  const row = rows[0];
  return row
    ? {
        id: row.id,
        objective: row.label,
        threadRef: row.channel_thread_ref ?? undefined,
        question: row.blocked_on ?? undefined,
      }
    : undefined;
}

/** The answer arrived. The task is running again. */
export async function unpark(
  client: PoolClient,
  scope: AccessScope,
  taskId: string
): Promise<void> {
  await client.query(
    `UPDATE tasks SET status = 'running', updated_at = now()
      WHERE id = $1 AND workspace_id = $2`,
    [taskId, scope.workspaceId]
  );
}
