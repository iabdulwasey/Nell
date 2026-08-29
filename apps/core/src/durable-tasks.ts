/**
 * A task that survives the process dying.
 *
 * The last unmet demo beat: *kill the server mid-task and it finishes.* DBOS
 * passed a crash-resume spike against real Postgres in Phase 0 — SIGKILLed
 * mid-step, resumed from its checkpoint, side-effecting step ran exactly once —
 * and then nothing at runtime imported it for months. Killing this process
 * halfway through a job lost the job, silently: the `tasks` row stayed
 * `running` for ever and the person who asked got nothing at all.
 *
 * **Why this comes after the task lifecycle rather than before it.** A durable
 * engine checkpoints *tasks*. While a task was "one message", durability would
 * have faithfully preserved the wrong granularity — resuming a fragment like
 * "Heathrow" rather than the goal it belonged to. Getting the boundary right
 * first is what makes a checkpoint worth taking.
 *
 * **What is and is not safe to replay**, which is the whole design:
 *
 * - A **completed step returns its checkpointed result** rather than re-running.
 *   That is the win: a research job that spent five minutes and produced a PDF
 *   does not spend five more.
 * - A step that was **interrupted re-runs from the beginning**. For the browser
 *   that means driving the page again, which is acceptable and not accidental:
 *   the profile persists so logins survive, and the spend gate refuses any click
 *   that commits money without a fresh approval. Replay cannot buy twice.
 * - **The reply is a step with an idempotency key**, so a recovered task does
 *   not tell you it is done a second time.
 *
 * The workflow takes only serializable input and finds everything else in module
 * state, because a closure cannot be checkpointed. That is also why `install`
 * exists: the deps must be in place before `launch`, since recovery of an
 * interrupted workflow begins the moment the engine starts.
 */

import { createDbosEngine, type DbosDurableEngine } from "@nell/durable";
import type { AccessScope } from "@nell/shared";

/** Everything a recovered task needs, held outside the workflow. */
export interface DurableDeps {
  /** Runs the task. Must be safe to re-enter for a task that was interrupted. */
  readonly run: (input: DurableTaskInput) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** Serializable, because DBOS checkpoints the input and replays it. */
export interface DurableTaskInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly taskId: string;
  readonly objective: string;
  readonly threadRef: string;
}

let deps: DurableDeps | undefined;
let engine: DbosDurableEngine | undefined;
let workflow: ((input: DurableTaskInput) => Promise<void>) | undefined;

/**
 * The system database, alongside the application one.
 *
 * DBOS keeps workflow state in its own database rather than in application
 * tables, which is what keeps its bookkeeping from colliding with RLS — its
 * rows are not tenant-scoped and would need a policy nobody has written. Same
 * server, so `docker compose up` is still one stateful dependency.
 */
export function systemDatabaseUrl(applicationUrl: string): string {
  return `${applicationUrl}_dbos_sys`;
}

/**
 * Register the workflow and start the engine.
 *
 * Order matters and is not cosmetic: registration must happen before `launch`,
 * because launching is also what recovers workflows the last process left
 * unfinished — and a workflow that is not registered by then cannot be resumed.
 */
/**
 * How long to wait for the engine before giving up on it.
 *
 * Not a nicety. A durable engine that cannot reach its system database **hangs**
 * rather than erroring — observed here, waiting indefinitely because the
 * application role is `NOSUPERUSER` and so cannot create the database DBOS
 * wanted. Without a bound the whole agent never finishes starting, and the
 * symptom is a process that is simply silent: no error, no Telegram, nothing.
 *
 * An optional subsystem must never be able to prevent the thing it is optional
 * to. Ten seconds is far longer than a local launch needs and short enough that
 * nobody watches it.
 */
export const LAUNCH_TIMEOUT_MS = 10_000;

export async function installDurableTasks(
  applicationUrl: string,
  next: DurableDeps
): Promise<DbosDurableEngine> {
  deps = next;
  workflow = undefined;
  engine = createDbosEngine({
    name: "nell",
    systemDatabaseUrl: systemDatabaseUrl(applicationUrl),
  });

  workflow = engine.defineWorkflow<DurableTaskInput>("nell.task", async (input) => {
    // Read at call time rather than captured, so a recovered workflow uses this
    // process's dependencies rather than a closure from the dead one.
    await deps?.run(input);
  });

  /**
   * Bounded, because `launch` can hang rather than reject — see above.
   *
   * The engine is left in place on timeout rather than torn down: shutting one
   * down mid-launch is its own hazard, and the caller treats a rejection here as
   * "no durability" regardless.
   */
  await Promise.race([
    engine.launch(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `the engine did not start within ${String(LAUNCH_TIMEOUT_MS / 1000)}s — its system ` +
                `database may be missing, and the application role cannot create one`
            )
          ),
        LAUNCH_TIMEOUT_MS
      ).unref();
    }),
  ]);

  return engine;
}

/**
 * Run a task durably, keyed by its own id.
 *
 * The workflow id *is* the task id, which is what makes recovery land on the
 * right row rather than starting a duplicate: DBOS refuses to run two workflows
 * under one id, so a task that is already in flight cannot be started twice by
 * a message arriving during recovery.
 */
export async function runDurably(input: DurableTaskInput): Promise<void> {
  if (!workflow || !engine) {
    // No engine configured — the task still runs, it simply does not survive a
    // crash. Degrading rather than refusing, because durability is an operator's
    // choice and an agent that will not answer without it is worse.
    await deps?.run(input);
    return;
  }

  await engine!.runAs(input.taskId, async () => {
    await workflow!(input);
  });
}

export async function shutdownDurableTasks(): Promise<void> {
  await engine?.shutdown();
  engine = undefined;
  workflow = undefined;
}

/** The scope a recovered task belongs to, rebuilt from what was checkpointed. */
export function scopeOf(input: DurableTaskInput): AccessScope {
  return { workspaceId: input.workspaceId, userId: input.userId };
}
