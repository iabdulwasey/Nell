/**
 * One browser, one driver at a time.
 *
 * Tasks can now run at once, which is the point — asking for two things should
 * get two things. But a workspace has exactly one browser, and two tasks driving
 * it is not merely untidy: the session carries **taint** (which fields have had
 * a credential typed into them) and **spend approvals**, both held per session
 * by the executor. Two tasks sharing one would share both. A password filled by
 * one task would mask screenshots for the other, and worse, an approval granted
 * for one task's £42 booking would be sitting there when the other reached a
 * payment page.
 *
 * So browse steps queue and everything else runs free. That is not a compromise
 * on concurrency, it is where the concurrency actually is: the expensive things
 * are research and writing, which touch no session at all, and those are exactly
 * the ones worth overlapping.
 *
 * A promise chain rather than a semaphore, because the queue is per workspace
 * and depth is bounded by the concurrency cap upstream. Nothing here needs to be
 * cleverer than "wait for the one in front".
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive use of the workspace's browser.
 *
 * The lock is released whether `fn` succeeds or throws — a task that fails
 * holding the machine would strand every task behind it, and a browser task
 * failing is ordinary rather than exceptional.
 */
export async function withMachine<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const ahead = queues.get(workspaceId) ?? Promise.resolve();

  /**
   * The chain is extended with a promise that cannot reject.
   *
   * If the stored promise could reject, the *next* caller would inherit that
   * rejection while waiting its turn — one task's failure becoming every later
   * task's failure. The caller still sees the real outcome through `result`.
   */
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(
    workspaceId,
    ahead.then(
      () => held,
      () => held
    )
  );

  await ahead.catch(() => undefined);

  try {
    return await fn();
  } finally {
    release();
  }
}

/** How many browse steps are waiting, for the log line that explains a pause. */
export function machineBusy(workspaceId: string): boolean {
  return queues.has(workspaceId);
}

/** Forget a workspace's queue. Tests only — a live queue must never be dropped. */
export function resetMachineQueues(): void {
  queues.clear();
}
