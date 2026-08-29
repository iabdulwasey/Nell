/**
 * DBOS adapter — the ONLY file that imports the durable-execution SDK.
 *
 * Everything else in Nell depends on the DurableEngine port, so replacing the
 * engine means writing a sibling adapter, not touching business code. See
 * docs/adr/0001-durable-engine-dbos.md for why DBOS, and for the crash-resume
 * spike that validated it.
 */

import { DBOS, WorkflowQueue } from "@dbos-inc/dbos-sdk";
import type { DurableEngine, EnqueueOptions, ScheduleOptions, StepOptions } from "../engine.js";

export interface DbosEngineConfig {
  /** Application name registered with the engine. */
  readonly name: string;
  /**
   * Connection string for the durable-execution system database.
   *
   * DBOS keeps workflow/step state in its own database. Point this at the same
   * Postgres server as application data so the deployment keeps a single
   * stateful dependency.
   */
  readonly systemDatabaseUrl: string;
}

/**
 * Wraps DBOS behind the port.
 *
 * Note on determinism: `step` is where every non-deterministic effect must live
 * (model calls, browser actions, network I/O, clock reads, randomness). Code in
 * a workflow body outside a step will be re-executed on replay.
 */
export class DbosDurableEngine implements DurableEngine {
  #launched = false;
  readonly #config: DbosEngineConfig;
  readonly #queues = new Map<string, WorkflowQueue>();

  constructor(config: DbosEngineConfig) {
    this.#config = config;
  }

  /** Must be called once at process start, before any workflow runs. */
  async launch(): Promise<void> {
    if (this.#launched) return;
    DBOS.setConfig({
      name: this.#config.name,
      systemDatabaseUrl: this.#config.systemDatabaseUrl,
    });
    await DBOS.launch();
    this.#launched = true;
  }

  async shutdown(): Promise<void> {
    if (!this.#launched) return;
    await DBOS.shutdown();
    this.#launched = false;
  }

  /**
   * `runStep`, not `registerStep` — and the difference is the whole reason this
   * adapter had never worked outside its own spike.
   *
   * `registerStep` declares a step *before the engine launches*; calling it
   * while a workflow is running throws "DBOS code is being registered after
   * DBOS.launch()". The port's `step(name, fn)` is by design an ad-hoc call from
   * inside a running workflow — business code should not have to hoist every
   * step to module scope to get a checkpoint — so the previous implementation
   * could only ever have worked in a program that registered everything up
   * front, which is exactly what the Phase 0 spike did. The spike passed, the
   * adapter looked proven, and the one path a real caller would take threw on
   * first use.
   *
   * `runStep` is the ad-hoc form: same checkpointing, no pre-registration.
   */
  async step<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> {
    return DBOS.runStep(fn, {
      name,
      ...(options?.maxAttempts !== undefined
        ? { retriesAllowed: true, maxAttempts: options.maxAttempts }
        : {}),
    });
  }

  async enqueue<T>(fn: () => Promise<T>, options: EnqueueOptions): Promise<T> {
    // Queues are created once per name and reused; the concurrency cap lives
    // with the queue definition.
    if (!this.#queues.has(options.queue)) {
      this.#queues.set(options.queue, new WorkflowQueue(options.queue));
    }
    const work = DBOS.registerWorkflow(fn, { name: `queued:${options.queue}` });
    if (options.idempotencyKey) {
      return DBOS.withNextWorkflowID(options.idempotencyKey, async () => work());
    }
    return work();
  }

  schedule(handler: () => Promise<void>, options: ScheduleOptions): void {
    DBOS.registerScheduled(handler, {
      name: options.name,
      crontab: options.cron,
    });
  }

  async sleep(ms: number): Promise<void> {
    await DBOS.sleep(ms);
  }

  async waitForEvent<T>(eventKey: string, timeoutMs?: number): Promise<T> {
    const value = await DBOS.getEvent<T>(
      eventKey,
      eventKey,
      timeoutMs ? timeoutMs / 1000 : undefined
    );
    if (value === null) {
      throw new Error(`Timed out waiting for event: ${eventKey}`);
    }
    return value;
  }

  async emitEvent<T>(eventKey: string, payload: T): Promise<void> {
    await DBOS.setEvent(eventKey, payload);
  }

  defineWorkflow<TInput>(
    name: string,
    handler: (input: TInput) => Promise<void>
  ): (input: TInput) => Promise<void> {
    return DBOS.registerWorkflow(handler, { name });
  }

  async runAs(id: string, fn: () => Promise<void>): Promise<void> {
    await DBOS.withNextWorkflowID(id, fn);
  }
}

export function createDbosEngine(config: DbosEngineConfig): DbosDurableEngine {
  return new DbosDurableEngine(config);
}
