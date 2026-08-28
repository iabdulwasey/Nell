/**
 * DBOS crash-resume spike.
 *
 * This is the gate on the durable-engine decision (docs/adr/0001). It proves the
 * headline product promise on real infrastructure: a multi-step task that is
 * killed mid-flight resumes from its last completed step, and a side-effecting
 * step never runs twice.
 *
 * Run in two passes against the same Postgres:
 *   pass 1 (`crash`)  — start the workflow, let step 1 commit, then SIGKILL
 *                       ourselves inside step 2.
 *   pass 2 (`resume`) — restart; DBOS recovers the pending workflow and
 *                       continues from step 2.
 *
 * Progress is recorded in a plain table so the assertions survive the kill and
 * can be checked from outside the process.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { Client } from "pg";

const WORKFLOW_ID = "nell-crash-resume-spike";

function databaseUrl(): string {
  const url = process.env.DBOS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DBOS_DATABASE_URL to run the spike.");
  return url;
}

/** DBOS keeps workflow state in its own database on the same server. */
function systemDatabaseUrl(): string {
  return `${databaseUrl()}_dbos_sys`;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Append-only record of every step execution, so replays are visible. */
async function recordStep(name: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("INSERT INTO spike_log (step_name, ran_at) VALUES ($1, now())", [name]);
  });
}

export async function setupSchema(): Promise<void> {
  await withClient(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS spike_log (
        id bigserial PRIMARY KEY,
        step_name text NOT NULL,
        ran_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });
}

export async function readLog(): Promise<{ step_name: string }[]> {
  return withClient(async (client) => {
    const result = await client.query<{ step_name: string }>(
      "SELECT step_name FROM spike_log ORDER BY id"
    );
    return result.rows;
  });
}

export async function resetLog(): Promise<void> {
  await withClient(async (client) => {
    await client.query("DROP TABLE IF EXISTS spike_log");
  });
}

/** Step 1: an ordinary durable step that completes before the crash. */
async function chargeCard(): Promise<string> {
  await recordStep("charge-card");
  return "charged";
}

/** Step 2: crashes the process on the first pass, succeeds on the second. */
async function bookTable(shouldCrash: boolean): Promise<string> {
  if (shouldCrash) {
    await recordStep("book-table-crashed-before-completion");
    // Hard kill: no cleanup, no unwinding — the harshest possible failure.
    process.kill(process.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  await recordStep("book-table");
  return "booked";
}

/** Step 3: only reachable after step 2 truly completes. */
async function sendReceipt(): Promise<string> {
  await recordStep("send-receipt");
  return "sent";
}

export async function runSpike(shouldCrash: boolean): Promise<void> {
  const chargeStep = DBOS.registerStep(chargeCard, { name: "chargeCard" });
  const bookStep = DBOS.registerStep(bookTable, { name: "bookTable" });
  const receiptStep = DBOS.registerStep(sendReceipt, { name: "sendReceipt" });

  const workflow = DBOS.registerWorkflow(
    async () => {
      await chargeStep();
      await bookStep(shouldCrash);
      await receiptStep();
    },
    { name: "bookingWorkflow" }
  );

  DBOS.setConfig({ name: "nell-spike", systemDatabaseUrl: systemDatabaseUrl() });
  await DBOS.launch();

  try {
    await DBOS.withNextWorkflowID(WORKFLOW_ID, async () => {
      await workflow();
    });
  } finally {
    await DBOS.shutdown();
  }
}

const mode = process.argv[2];
if (mode === "crash" || mode === "resume") {
  if (mode === "crash") await setupSchema();
  await runSpike(mode === "crash");
} else if (mode === "reset") {
  await resetLog();
} else if (mode === "read") {
  console.log(JSON.stringify(await readLog()));
}
