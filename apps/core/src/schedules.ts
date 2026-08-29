/**
 * Recurring work.
 *
 * The gap this closes was reported by the user, twice, in their own words:
 * "you need to remember this and do scans every 6 am and send me updates". Nell
 * answered that it could not — correctly, since nothing was wired, while
 * `monitors` sat in the schema and `claimDue`/`completeRun` sat tested in
 * `@nell/memory` with no database under them.
 *
 * Everything here is deliberately the *narrow* version of the proactivity
 * design. Three things it is not:
 *
 * **Not a general scheduler.** One recurrence, expressed in minutes, with a
 * first run at a wall-clock time. No cron expressions, no "second Tuesday", no
 * timezone database — the interval and a start time cover "every morning" and
 * "every few hours", which is what people actually ask for.
 *
 * **Not multi-tenant.** The tick runs inside a workspace, because row-level
 * security means a query outside one matches nothing. A scheduler serving every
 * tenant needs a role with a policy written for it, and that is a real design
 * decision rather than an oversight to paper over with a superuser connection —
 * which is exactly the shortcut the boot check refuses.
 *
 * **Not a monitor.** The pre-check machinery exists so an always-on watch costs
 * nothing when nothing changed. A daily news scan has no cheap pre-check: you
 * have to go and look. So these run the task and report — with digest dedup
 * available, since the table already carries a uniqueness constraint for it.
 */

import type { PoolClient } from "pg";
import { createHash, randomUUID } from "node:crypto";
import type { AccessScope } from "@nell/shared";

export interface Schedule {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly everyMinutes: number;
  readonly threadRef: string | undefined;
}

/** The check type used for work that has to run to find out whether anything changed. */
export const RUN_ALWAYS = "page-changed";

export interface CreateScheduleInput {
  readonly label: string;
  readonly prompt: string;
  readonly everyMinutes: number;
  /** Epoch millis of the first run. */
  readonly firstRunAt: number;
  readonly threadRef: string;
}

export async function createSchedule(
  client: PoolClient,
  scope: AccessScope,
  input: CreateScheduleInput
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO monitors
       (id, workspace_id, label, check_type, check_config, prompt,
        channel_thread_ref, every_minutes, next_run_at, enabled)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, to_timestamp($8 / 1000.0), true)`,
    [
      id,
      scope.workspaceId,
      input.label.slice(0, 120),
      RUN_ALWAYS,
      input.prompt,
      input.threadRef,
      input.everyMinutes,
      input.firstRunAt,
    ]
  );
  return id;
}

/**
 * Claim what is due, and mark it leased in the same statement.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run from more than one
 * process: a row being claimed elsewhere is skipped rather than waited on, so
 * two tickers never run the same schedule and neither blocks. The lease is the
 * second half — a process that dies mid-run holds the row only until the lease
 * expires, after which someone else picks it up. Without it a crash would
 * silently retire a schedule, which is the failure nobody notices because its
 * symptom is *nothing happening*.
 */
export async function claimDue(
  client: PoolClient,
  scope: AccessScope,
  now: number,
  limit = 25
): Promise<readonly Schedule[]> {
  const { rows } = await client.query<{
    id: string;
    label: string;
    prompt: string;
    every_minutes: number | null;
    channel_thread_ref: string | null;
  }>(
    `UPDATE monitors SET lease_expires_at = to_timestamp($2 / 1000.0) + interval '5 minutes'
      WHERE id IN (
        SELECT id FROM monitors
         WHERE workspace_id = $1
           AND enabled
           AND every_minutes IS NOT NULL
           AND next_run_at <= to_timestamp($2 / 1000.0)
           AND (lease_expires_at IS NULL OR lease_expires_at <= to_timestamp($2 / 1000.0))
         ORDER BY next_run_at
         FOR UPDATE SKIP LOCKED
         LIMIT $3
      )
      RETURNING id, label, prompt, every_minutes, channel_thread_ref`,
    [scope.workspaceId, now, limit]
  );

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    prompt: row.prompt,
    everyMinutes: row.every_minutes ?? 1440,
    threadRef: row.channel_thread_ref ?? undefined,
  }));
}

/**
 * Release a schedule and set its next run.
 *
 * From `now`, not from the run that was due. A task that took ten minutes, or a
 * process that was down for an hour, must not leave the schedule permanently
 * behind — stacking up missed runs to fire back to back is the classic
 * catch-up storm, and for something that texts you it means a burst of eight
 * messages at once.
 */
export async function completeRun(
  client: PoolClient,
  scope: AccessScope,
  scheduleId: string,
  now: number,
  everyMinutes: number
): Promise<void> {
  await client.query(
    `UPDATE monitors
        SET lease_expires_at = NULL,
            next_run_at = to_timestamp($3 / 1000.0) + ($4 || ' minutes')::interval
      WHERE id = $1 AND workspace_id = $2`,
    [scheduleId, scope.workspaceId, now, String(everyMinutes)]
  );
}

export async function listSchedules(
  client: PoolClient,
  scope: AccessScope
): Promise<readonly Schedule[]> {
  const { rows } = await client.query<{
    id: string;
    label: string;
    prompt: string;
    every_minutes: number | null;
    channel_thread_ref: string | null;
  }>(
    `SELECT id, label, prompt, every_minutes, channel_thread_ref
       FROM monitors
      WHERE workspace_id = $1 AND enabled AND every_minutes IS NOT NULL
      ORDER BY next_run_at`,
    [scope.workspaceId]
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    prompt: row.prompt,
    everyMinutes: row.every_minutes ?? 1440,
    threadRef: row.channel_thread_ref ?? undefined,
  }));
}

export async function cancelAll(client: PoolClient, scope: AccessScope): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE monitors SET enabled = false
      WHERE workspace_id = $1 AND enabled AND every_minutes IS NOT NULL`,
    [scope.workspaceId]
  );
  return rowCount ?? 0;
}

/**
 * Whether this result is new.
 *
 * The uniqueness constraint does the deciding, not a read followed by a write:
 * two ticks racing on the same digest would both see "not reported" and both
 * send. `ON CONFLICT DO NOTHING` makes the database the arbiter, and the row
 * count is the answer.
 */
export async function recordIfNew(
  client: PoolClient,
  scope: AccessScope,
  scheduleId: string,
  content: string
): Promise<boolean> {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const { rowCount } = await client.query(
    `INSERT INTO monitor_reports (workspace_id, monitor_id, content_digest)
     VALUES ($1, $2, $3)
     ON CONFLICT (monitor_id, content_digest) DO NOTHING`,
    [scope.workspaceId, scheduleId, digest]
  );
  return (rowCount ?? 0) > 0;
}
