/**
 * Running a task.
 *
 * The first thing in this repository that joins the pieces up: a request becomes
 * a persisted row, the row becomes a browser session, the session is driven
 * through the policy chokepoint, and the outcome is written back — all inside
 * transactions scoped to one workspace.
 *
 * Everything it composes was built and tested separately, which is exactly why
 * this file matters. A thousand passing unit tests establish that each part
 * behaves correctly when called correctly; none of them establish that the parts
 * fit together, or that the sequence is right when something fails halfway.
 *
 * Two things it is careful about:
 *
 * **A session always gets cleaned up.** A browser left open after a failed task
 * is a machine burning money and, on a persistent machine, a page left in a
 * state the next task will be surprised by. The cleanup is in a `finally` and
 * its own failure is swallowed, because failing to tidy up must not replace the
 * real error with a less useful one.
 *
 * **Status is written even when the task fails.** A row stuck in `running`
 * forever is worse than one marked `failed`: it looks like work in progress, so
 * nothing retries it and nobody investigates.
 */

import { authorizeTool, type BrowserExecutor } from "@nell/aegis";
import type { BrowserAction, BrowserProvider } from "@nell/browser";
import type { AccessScope, Provenance } from "@nell/shared";
import type { Pool } from "pg";
import { withWorkspace } from "./db.js";

export interface RunnerDeps {
  readonly pool: Pool;
  readonly provider: BrowserProvider;
  /** The policy chokepoint. Every action goes through it, including ours. */
  readonly executor: BrowserExecutor;
  readonly now: () => number;
}

export interface TaskRequest {
  readonly scope: AccessScope;
  readonly id: string;
  readonly label: string;
  readonly startUrl: string;
  readonly actions: readonly BrowserAction[];
  /**
   * Where the instruction came from. A task whose only basis is untrusted
   * content cannot run at all — the gate is consulted before a browser is even
   * opened, because opening one already costs money.
   */
  readonly provenance: Provenance;
}

export type TaskResult =
  | { readonly ok: true; readonly taskId: string; readonly extracted?: Record<string, string> }
  | { readonly ok: false; readonly taskId: string; readonly reason: string };

/**
 * Create the task row.
 *
 * Written before anything is attempted, so a crash between here and the browser
 * leaves a visible `running` row rather than no evidence that anything was asked
 * for.
 */
async function createTask(deps: RunnerDeps, request: TaskRequest): Promise<void> {
  await withWorkspace(deps.pool, request.scope, async (client) => {
    await client.query(
      `INSERT INTO tasks (id, workspace_id, label, status, updated_at)
       VALUES ($1, $2, $3, 'running', now())
       ON CONFLICT (id) DO UPDATE SET status = 'running', updated_at = now()`,
      [request.id, request.scope.workspaceId, request.label]
    );
  });
}

async function finishTask(
  deps: RunnerDeps,
  scope: AccessScope,
  taskId: string,
  status: "done" | "failed",
  sessionId?: string
): Promise<void> {
  await withWorkspace(deps.pool, scope, async (client) => {
    await client.query(
      `UPDATE tasks SET status = $2, browser_session_id = $3, updated_at = now() WHERE id = $1`,
      [taskId, status, sessionId ?? null]
    );
  });
}

/**
 * Run one task, start to finish.
 *
 * The ordering here is the substance. The provenance gate runs first, before any
 * resource is acquired; the row is written before the browser opens; the browser
 * is closed whatever happens; and the status is written last, from a code path
 * that both the success and the failure branch reach.
 */
export async function runTask(deps: RunnerDeps, request: TaskRequest): Promise<TaskResult> {
  // Driving a browser is consequential — it spends a machine and can reach a
  // checkout. Checked before anything is created, because a refusal after
  // opening a session has already cost what the refusal was meant to save.
  const gate = authorizeTool(
    { newContext: [request.provenance], userConfirmed: false },
    "use-credential"
  );
  if (!gate.allowed) {
    return { ok: false, taskId: request.id, reason: gate.reason };
  }

  await createTask(deps, request);

  let sessionId: string | undefined;
  try {
    const session = await deps.provider.createSession(request.scope, {
      startUrl: request.startUrl,
    });
    sessionId = session.id;

    const outcome = await deps.executor.execute(request.scope, session.id, {
      kind: "targeted",
      actions: request.actions,
    });

    if (!outcome.ok) {
      await finishTask(deps, request.scope, request.id, "failed", sessionId);
      return { ok: false, taskId: request.id, reason: outcome.reason };
    }

    await finishTask(deps, request.scope, request.id, "done", sessionId);
    return { ok: true, taskId: request.id, extracted: outcome.result.extracted };
  } catch (error) {
    await finishTask(deps, request.scope, request.id, "failed", sessionId);
    return {
      ok: false,
      taskId: request.id,
      reason: error instanceof Error ? error.message : "The task failed.",
    };
  } finally {
    if (sessionId) {
      // Its own failure must not replace the real error with a less useful one.
      await deps.provider.destroy(request.scope, sessionId).catch(() => undefined);
    }
  }
}

export interface TaskRow {
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

/** Read a workspace's tasks. Scoped by the transaction, not by a WHERE clause. */
export async function listTasks(pool: Pool, scope: AccessScope): Promise<readonly TaskRow[]> {
  return withWorkspace(pool, scope, async (client) => {
    const { rows } = await client.query<TaskRow>(
      "SELECT id, label, status FROM tasks ORDER BY created_at DESC LIMIT 50"
    );
    return rows;
  });
}
