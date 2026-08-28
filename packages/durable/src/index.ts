/**
 * @nell/durable
 *
 * The DurableEngine PORT (workflow/step/enqueue/schedule/sleep/waitForEvent)
 * plus the single DBOS adapter. Business code imports the port ONLY; this is the
 * one place the durable-engine SDK is referenced, so the engine stays swappable.
 *
 * Governed by: docs/adr/0001-durable-engine-dbos.md
 *
 * Status: scaffold — the port interface is real; the DBOS adapter lands in
 * Phase 0 (the crash-resume spike is the first task and gates the engine).
 */

export type { DurableEngine, StepOptions, EnqueueOptions, ScheduleOptions } from "./engine.js";

export { createDbosEngine, DbosDurableEngine, type DbosEngineConfig } from "./adapters/dbos.js";
