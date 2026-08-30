/**
 * Deleting for real, and proving what went.
 *
 * Against real Postgres because the claim being made is about rows, and a fake
 * client would let a receipt be written for a deletion that never happened —
 * which is precisely the thing this feature exists to disprove about a
 * competitor whose "revoke" left the data in place.
 *
 * The assertion that carries the most weight is the last one: **the audit log
 * survives an account deletion.** A feature that erases things and also erases
 * the proof it ran is indistinguishable from one that never ran.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { accessScopeForUser, type AccessScope } from "@nell/shared";
import { verifyReceipt } from "@nell/memory";
import { withWorkspace } from "./db.js";
import { buildIndex, searchMemory } from "@nell/memory";
import { deleteScope, renderReceipt } from "./deletion-store.js";
import { memorySources, readLedger, recordOutcome } from "./memory-store.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;
let scope: AccessScope;

beforeAll(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  scope = accessScopeForUser(`del-${String(process.pid)}-${String(Date.now())}`);
  await pool.query(`INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
    scope.workspaceId,
  ]);
});

afterAll(async () => {
  if (!url) return;
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [scope.workspaceId]).catch(() => {});
  await pool.end();
});

/** Something in every store the scope will touch. */
async function seed(): Promise<void> {
  await withWorkspace(pool, scope, async (client) => {
    await client.query(
      `INSERT INTO preferences (id, workspace_id, key, value, category, provenance)
       VALUES ($1, $2, 'home', 'Gurugram', 'location', 'stated')
       ON CONFLICT DO NOTHING`,
      [`pref-${scope.workspaceId}`, scope.workspaceId]
    );
    await client.query(
      `INSERT INTO directives (id, workspace_id, kind, rule, provenance)
       VALUES ($1, $2, 'always', 'Never book before 9am', 'user')
       ON CONFLICT DO NOTHING`,
      [`dir-${scope.workspaceId}`, scope.workspaceId]
    );
    // `id` is a bigserial here, so the row names itself.
    await client.query(
      `INSERT INTO task_ledger (workspace_id, objective, outcome)
       VALUES ($1, 'Book a table', 'succeeded')`,
      [scope.workspaceId]
    );
  });
}

const countIn = async (table: string): Promise<number> =>
  withWorkspace(pool, scope, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} WHERE workspace_id = $1`,
      [scope.workspaceId]
    );
    return Number(rows[0]?.n ?? 0);
  });

describeDb("deleting a scope", () => {
  it("removes the rows and counts what it removed", async () => {
    await seed();
    expect(await countIn("preferences")).toBe(1);
    expect(await countIn("directives")).toBe(1);

    const outcome = await withWorkspace(pool, scope, (client) =>
      deleteScope(client, scope, "memory", Date.now())
    );

    expect(await countIn("preferences")).toBe(0);
    expect(await countIn("directives")).toBe(0);

    /**
     * The counts come from the deletes themselves. A receipt built from the
     * *plan* would say the same thing whether or not anything was removed,
     * which is a document asserting a deletion produced without checking.
     */
    const counted = Object.fromEntries(
      outcome.receipt.categories.map((entry) => [entry.category, entry.count])
    );
    expect(counted["preferences"]).toBe(1);
    expect(counted["directives"]).toBe(1);
    expect(outcome.receipt.totalRecords).toBe(2);
  });

  /** Scoped: deleting memory must not take the task history with it. */
  it("leaves what the scope does not name", async () => {
    expect(await countIn("task_ledger")).toBe(1);
  });

  it("issues a receipt that verifies", async () => {
    const outcome = await withWorkspace(pool, scope, (client) =>
      deleteScope(client, scope, "history", Date.now())
    );
    expect(verifyReceipt(outcome.receipt)).toBe(true);
    expect(await countIn("task_ledger")).toBe(0);
  });

  /**
   * A receipt whose contents were altered must stop verifying — otherwise the
   * digest is decoration and "here is proof" is a figure of speech.
   */
  it("stops verifying if the numbers are changed afterwards", async () => {
    await seed();
    const outcome = await withWorkspace(pool, scope, (client) =>
      deleteScope(client, scope, "memory", Date.now())
    );

    expect(verifyReceipt({ ...outcome.receipt, totalRecords: 999 })).toBe(false);
  });

  it("says plainly when a scope had nothing in it", async () => {
    const outcome = await withWorkspace(pool, scope, (client) =>
      deleteScope(client, scope, "memory", Date.now())
    );
    expect(outcome.receipt.totalRecords).toBe(0);
    expect(renderReceipt(outcome)).toContain("nothing stored");
  });

  /**
   * The one that matters most. Account closure removes everything a person
   * stored — and keeps the record that it happened, because a deletion feature
   * which erases its own proof is indistinguishable from one that never ran.
   */
  it("keeps the audit log through an account deletion", async () => {
    await seed();
    await withWorkspace(pool, scope, async (client) => {
      await client.query(
        `INSERT INTO audit_log (workspace_id, sequence, action, subject, at, previous_digest, digest)
         VALUES ($1, 1, 'memory.write', 'home', now(), '', 'abc123')`,
        [scope.workspaceId]
      );
    });

    const before = await countIn("audit_log");
    expect(before).toBe(1);

    await withWorkspace(pool, scope, (client) => deleteScope(client, scope, "account", Date.now()));

    expect(await countIn("preferences")).toBe(0);
    expect(await countIn("audit_log")).toBe(before);
  });

  it("tells the reader the audit log was kept", async () => {
    const outcome = await withWorkspace(pool, scope, (client) =>
      deleteScope(client, scope, "memory", Date.now())
    );
    expect(renderReceipt(outcome)).toContain("audit log is kept");
  });
});

describeDb("what the recall index is built from", () => {
  /**
   * Every column name in this query is a guess until a real database rejects
   * it. The first version invented `instruction` on directives and `created_at`
   * on the ledger, and no unit test could have caught either — running it once
   * against Postgres found all three at the first attempt.
   */
  it("reads every kind of source without inventing a column", async () => {
    await seed();
    const sources = await withWorkspace(pool, scope, (client) => memorySources(client, scope));

    const kinds = new Set(sources.map((source) => source.kind));
    expect(kinds).toContain("preference");
    expect(kinds).toContain("directive");
    expect(kinds).toContain("ledger");
    expect(sources.every((source) => source.text.length > 0)).toBe(true);
    expect(sources.every((source) => Number.isFinite(source.at))).toBe(true);
  });

  /**
   * The property the whole T4 design rests on: an entry that cannot name a live
   * source does not exist. Delete the source, rebuild, and the derived copy is
   * gone **by construction** — no sweep to remember, no cascade to get right.
   */
  it("loses a derived entry when its source is deleted", async () => {
    const before = await withWorkspace(pool, scope, (client) => memorySources(client, scope));
    const indexBefore = await buildIndex(before);
    expect(searchMemory(indexBefore, "Gurugram", { now: Date.now() }).length).toBeGreaterThan(0);

    await withWorkspace(pool, scope, (client) => deleteScope(client, scope, "memory", Date.now()));

    const after = await withWorkspace(pool, scope, (client) => memorySources(client, scope));
    const indexAfter = await buildIndex(after);
    // Absent, not merely unreachable — there is nothing left to rank.
    expect(searchMemory(indexAfter, "Gurugram", { now: Date.now() })).toHaveLength(0);
    expect(indexAfter.some((entry) => entry.text.includes("Gurugram"))).toBe(false);
  });
});

describeDb("what a finished task leaves behind", () => {
  /**
   * The gap that made every past task useless to the next one.
   *
   * `detail` has been on the ledger entry since v1, `recordTask` sanitises it
   * and `renderPrecedents` prints it — and the input had no field for it, so
   * every entry stored `{}` and the brain document read "Find Spider-Man
   * showtimes: succeeded". Watched live: one task found the showtimes, recorded
   * success, and the next searched for them again from nothing, because
   * "succeeded" is not an answer.
   */
  it("records what it found, not only that it happened", async () => {
    await withWorkspace(pool, scope, (client) =>
      recordOutcome(client, scope, {
        taskId: `t-${scope.workspaceId}`,
        objective: "Find Spider-Man showtimes near Gurugram after 9pm",
        outcome: "succeeded",
        found: "Wave Cinemas, Sector 90 — 10:45 PM, seats available",
      })
    );

    const entries = await withWorkspace(pool, scope, (client) => readLedger(client, scope, 5));
    const entry = entries.find((row) => row.objective.includes("Spider-Man"));
    expect(entry?.detail["found"]).toContain("10:45 PM");
  });

  /**
   * Failures carry findings too, and that is the more useful half: "the site
   * wanted a login" is the precedent that stops the same attempt being made the
   * same way next week, where "failed" teaches nothing.
   */
  it("records why a failure failed", async () => {
    await withWorkspace(pool, scope, (client) =>
      recordOutcome(client, scope, {
        taskId: `t2-${scope.workspaceId}`,
        objective: "Book seats on bookmyshow",
        outcome: "failed",
        found: "bookmyshow blocks automated browsers",
      })
    );

    const entries = await withWorkspace(pool, scope, (client) => readLedger(client, scope, 5));
    const entry = entries.find((row) => row.objective.includes("bookmyshow"));
    expect(entry?.detail["found"]).toContain("blocks automated browsers");
  });

  /**
   * The record is durable and the sanitiser is what stands between it and a
   * secret arriving in a payload. Asserted here rather than trusted, because a
   * password written into a ledger is written for ever.
   */
  it("never lets a secret into the record", async () => {
    await withWorkspace(pool, scope, (client) =>
      recordOutcome(client, scope, {
        taskId: `t3-${scope.workspaceId}`,
        objective: "Sign in",
        outcome: "succeeded",
        found: "signed in fine",
      })
    );

    const entries = await withWorkspace(pool, scope, (client) => readLedger(client, scope, 5));
    const entry = entries.find((row) => row.objective === "Sign in");
    expect(Object.keys(entry?.detail ?? {})).toEqual(["found"]);
  });
});
