/**
 * The audit log against a real database.
 *
 * The chain arithmetic has its own unit tests and they cover the digests. Two
 * things are untested until now, and the second turned out to be a stronger
 * guarantee than the code that uses it assumed.
 *
 * **One: does the chain survive Postgres.** This is where hash chains usually
 * die — a digest computed over a JavaScript `Date` and verified over a string
 * never matches, and the symptom is a log that reports itself corrupt on a
 * system where nothing is wrong.
 *
 * **Two: the log is append-only in the database, not merely by convention.** A
 * trigger refuses UPDATE and DELETE outright. That is worth a great deal more
 * than "nothing in our code updates it": no code path, no migration, no console
 * session and no compromised process can quietly rewrite history, because the
 * refusal does not depend on the application being the one doing the asking.
 *
 * **Why nothing is cleaned up here.** It cannot be — that is the point of the
 * previous paragraph — so every run uses a workspace nobody else will use. A
 * test suite that could tidy an append-only log would be evidence the log was
 * not append-only.
 */

import { accessScopeForUser } from "@nell/shared";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditSink, readAudit, recordEntry } from "./audit-store.js";
import { createPool, withWorkspace } from "./db.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;

/** A workspace per run, because an append-only log has no undo. */
const fresh = () => accessScopeForUser(`audit-${randomUUID()}`);

const at = (minute: number) => `2026-08-30T09:${String(minute).padStart(2, "0")}:00.000Z`;

async function workspace() {
  const scope = fresh();
  await withWorkspace(pool, scope, (client) =>
    client.query("INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING", [
      scope.workspaceId,
    ])
  );
  return scope;
}

beforeAll(() => {
  if (!url) return;
  pool = createPool(url);
});

afterAll(async () => {
  if (!url) return;
  await pool.end();
});

const write = (
  scope: ReturnType<typeof fresh>,
  action: "vault.fill" | "policy.deny",
  subject: string,
  minute: number
) =>
  withWorkspace(pool, scope, (client) =>
    recordEntry(client, scope, {
      workspaceId: scope.workspaceId,
      action,
      subject,
      at: at(minute),
    })
  );

describeDb("writing it down", () => {
  it("chains each entry to the one before it, and still verifies after a round trip", async () => {
    const scope = await workspace();
    await write(scope, "vault.fill", "item-1", 1);
    await write(scope, "policy.deny", "spend", 2);
    await write(scope, "vault.fill", "item-2", 3);

    const view = await readAudit(pool, scope);

    expect(view.total).toBe(3);
    // The part that usually breaks: a digest computed over one representation
    // of a timestamp and verified over another.
    expect(view.valid).toBe(true);
    // Newest first, because that is what a person opening this wants to see.
    expect(view.entries.map((entry) => entry.sequence)).toEqual([3, 2, 1]);
    expect(view.entries[0]?.previousDigest).toBe(view.entries[1]?.digest);
    // A chain starts at one and its first entry commits to nothing before it.
    expect(view.entries[2]?.previousDigest).toBe("");
  });

  it("records what happened, and never a secret", async () => {
    const scope = await workspace();
    await withWorkspace(pool, scope, (client) =>
      recordEntry(client, scope, {
        workspaceId: scope.workspaceId,
        action: "vault.fill",
        subject: "session-7",
        detail: { itemId: "abc-123", field: "password", origin: "https://shop.example" },
        at: at(1),
      })
    );

    const view = await readAudit(pool, scope);
    const entry = view.entries[0];

    // Which item, which field, which site — enough to answer "what did it do",
    // and nothing that would make this a second copy of the vault.
    expect(entry?.detail).toMatchObject({ field: "password", origin: "https://shop.example" });
    expect(JSON.stringify(entry)).not.toContain("correct horse");
  });
});

/**
 * The guarantee that does not depend on us.
 *
 * Everything else in this repository is our code checking itself. This is the
 * database refusing, which is the only control here that survives our code
 * being wrong — or being the attacker.
 */
describeDb("append-only, enforced by the database", () => {
  it("refuses an UPDATE, so history cannot be quietly rewritten", async () => {
    const scope = await workspace();
    await write(scope, "vault.fill", "item-1", 1);

    await expect(
      withWorkspace(pool, scope, (client) =>
        client.query(`UPDATE audit_log SET subject = 'something-else' WHERE workspace_id = $1`, [
          scope.workspaceId,
        ])
      )
    ).rejects.toThrow(/append-only/iu);

    // And the entry is untouched, rather than half-written by a partial failure.
    const view = await readAudit(pool, scope);
    expect(view.entries[0]?.subject).toBe("item-1");
    expect(view.valid).toBe(true);
  });

  it("refuses a DELETE, so an entry cannot be removed after the fact", async () => {
    const scope = await workspace();
    await write(scope, "vault.fill", "item-1", 1);
    await write(scope, "policy.deny", "spend", 2);

    await expect(
      withWorkspace(pool, scope, (client) =>
        client.query(`DELETE FROM audit_log WHERE workspace_id = $1 AND sequence = 1`, [
          scope.workspaceId,
        ])
      )
    ).rejects.toThrow(/append-only/iu);

    expect((await readAudit(pool, scope)).total).toBe(2);
  });

  /** Appending is the one thing that must still work. */
  it("still allows an append", async () => {
    const scope = await workspace();
    const entry = await write(scope, "vault.fill", "item-1", 1);
    expect(entry.sequence).toBe(1);
  });
});

/**
 * The test that would have caught it.
 *
 * The first version of `recordEntry` read the tail with `SELECT … FOR UPDATE`,
 * which on this table silently returns nothing — the RLS policy for UPDATE is
 * `USING (false)`, and Postgres applies that policy when you lock a row for
 * update. So every append believed it was the first, restarted the sequence at
 * 1, and was saved only by the primary key rejecting the duplicate.
 *
 * Sequential appends failed loudly enough to notice. What this asserts is the
 * harder half: that appends racing each other all survive, in one contiguous
 * chain, with none quietly dropped.
 */
describeDb("appends that race each other", () => {
  it("keeps every one, in one contiguous chain", async () => {
    const scope = await workspace();
    const sink = auditSink(pool, scope, (note) => {
      throw new Error(note);
    });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sink.record({ action: "vault.fill", subject: `item-${String(index)}`, at: at(index) })
      )
    );

    const view = await readAudit(pool, scope, 50);

    // Nothing lost — a race that drops an audit entry is the specific failure
    // this file exists to prevent.
    expect(view.total).toBe(8);
    expect(view.valid).toBe(true);
    // And no gaps: sequences run 1..8 with nothing skipped.
    expect(view.entries.map((entry) => entry.sequence).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // Every subject arrived exactly once.
    expect(new Set(view.entries.map((entry) => entry.subject)).size).toBe(8);
  });
});

describeDb("one workspace's log", () => {
  it("is a separate chain from another's, both starting at one", async () => {
    const mine = await workspace();
    const theirs = await workspace();

    await write(mine, "vault.fill", "mine", 1);
    await write(theirs, "vault.fill", "theirs", 5);

    const a = await readAudit(pool, mine);
    const b = await readAudit(pool, theirs);

    // Sequences are per-workspace, so both are 1 and neither can see the other.
    expect(a.total).toBe(1);
    expect(b.total).toBe(1);
    expect(a.entries[0]?.subject).toBe("mine");
    expect(b.entries[0]?.subject).toBe("theirs");
  });
});

describeDb("the sink the executor holds", () => {
  it("records without being told which workspace it is in", async () => {
    const scope = await workspace();
    const sink = auditSink(pool, scope);

    await sink.record({ action: "vault.fill", subject: "item-1", at: at(1) });
    await sink.record({ action: "policy.deny", subject: "clipboard", at: at(2) });

    const view = await readAudit(pool, scope);
    expect(view.total).toBe(2);
    expect(view.valid).toBe(true);
  });

  /**
   * A failure to write the record must not be reported as a failure to act.
   *
   * The fill has already happened by the time `record` is called — the password
   * is on the page whether or not we managed to write it down — so throwing
   * here would tell the user a task failed that in fact succeeded. It goes to
   * the operator's log instead, loudly.
   */
  it("reports a write failure without throwing into the caller", async () => {
    const notes: string[] = [];
    const broken = { connect: () => Promise.reject(new Error("no database")) } as unknown as Pool;
    const sink = auditSink(broken, fresh(), (note) => notes.push(note));

    await expect(
      sink.record({ action: "vault.fill", subject: "item-1", at: at(1) })
    ).resolves.toBeUndefined();

    expect(notes[0]).toContain("AUDIT WRITE FAILED");
    expect(notes[0]).toContain("vault.fill");
  });
});
