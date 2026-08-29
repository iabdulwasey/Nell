/**
 * @nell/durable — the DurableEngine port.
 *
 * This is the reversibility seam for the durable-execution engine (DBOS Transact
 * today; see docs/adr/0001-durable-engine-dbos.md). ALL business code depends on
 * this interface and never imports the engine SDK directly. Exactly one adapter
 * (adapters/dbos.ts) implements it against DBOS, so swapping engines later is a
 * new adapter file, not a refactor.
 *
 * Contract notes:
 * - Workflows must be deterministic: every non-deterministic effect (LLM call,
 *   browser action, tool call, clock read, randomness, I/O) MUST run inside a
 *   `step`. This is lint-enforced in CI.
 * - Side-effecting steps take an idempotency key so exactly-once holds across
 *   crash-resume.
 */

/** A unit of non-deterministic work, memoized once completed. */
export interface StepOptions {
  /** Stable idempotency key for exactly-once side effects (payments, sends). */
  readonly key?: string;
  /** Max attempts before the step is considered failed. */
  readonly maxAttempts?: number;
}

/** Options for enqueuing durable work onto a concurrency-capped queue. */
export interface EnqueueOptions {
  readonly queue: string;
  /** Per-workspace (or per-key) concurrency cap. */
  readonly concurrencyKey?: string;
  readonly idempotencyKey?: string;
}

/** A registered cron/scheduled workflow. */
export interface ScheduleOptions {
  /** 5-field crontab expression, evaluated in UTC. */
  readonly cron: string;
  readonly name: string;
}

/**
 * The durable-execution surface Nell depends on. Kept intentionally small; the
 * adapter maps each method onto the underlying engine's primitives.
 */
export interface DurableEngine {
  /**
   * Run `fn` as a durable step. On crash-resume a completed step returns its
   * checkpointed result instead of re-executing. Wrap every non-deterministic
   * effect in one of these.
   */
  step<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T>;

  /** Enqueue durable work; respects the queue's concurrency cap. */
  enqueue<T>(fn: () => Promise<T>, options: EnqueueOptions): Promise<T>;

  /** Register a cron-scheduled workflow (the proactivity heartbeat, digests). */
  schedule(handler: () => Promise<void>, options: ScheduleOptions): void;

  /**
   * Durably suspend the current workflow for `ms`, holding no compute while
   * parked. Resumes in the same workflow after the delay.
   */
  sleep(ms: number): Promise<void>;

  /**
   * Durably park until an external event with `eventKey` arrives (approval,
   * OAuth callback, monitor tick). Holds no compute while waiting.
   */
  waitForEvent<T>(eventKey: string, timeoutMs?: number): Promise<T>;

  /** Deliver an event that a parked `waitForEvent` is waiting on. */
  emitEvent<T>(eventKey: string, payload: T): Promise<void>;

  /**
   * Register a workflow, once, before the engine launches.
   *
   * Ordering is a contract rather than a convention: launching is also what
   * recovers workflows the previous process left unfinished, so a workflow not
   * registered by then cannot be resumed — it is simply gone.
   *
   * The handler takes serializable input and nothing else. A closure cannot be
   * checkpointed, so anything else it needs must be reachable from module state
   * that the *new* process sets up before launching.
   */
  defineWorkflow<TInput>(
    name: string,
    handler: (input: TInput) => Promise<void>
  ): (input: TInput) => Promise<void>;

  /**
   * Run a registered workflow under a caller-chosen id.
   *
   * The id is what makes recovery land on the right thing and what stops a
   * duplicate: an engine refuses two workflows under one id, so a task already
   * in flight cannot be started a second time by a message that arrives while
   * the first is recovering.
   */
  runAs(id: string, fn: () => Promise<void>): Promise<void>;
}
