/**
 * Tenant isolation, against a real database.
 *
 * Every other test in this repository checks a decision function. This one
 * checks the backstop underneath them: if a query somewhere forgets its
 * workspace filter, row-level security is what stands between one user and
 * another's data. That guarantee cannot be unit-tested — it lives in Postgres,
 * and only Postgres can be asked whether it holds.
 *
 * Connects as the restricted role on purpose. A superuser bypasses RLS entirely
 * even on a table marked FORCE, so a version of this test that connected as the
 * owner would pass while proving the opposite of what it claims.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let client: pg.Client;

/** Unique per run, so two runs of this suite never share a workspace. */
const ALPHA = `ws-alpha-${randomUUID()}`;
/** Task ids unique per run too — the same collision the workspace ids avoid. */
const T_ALPHA = `t-alpha-${randomUUID()}`;
const T_FORGED = `t-forged-${randomUUID()}`;
const BETA = `ws-beta-${randomUUID()}`;

async function asWorkspace<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
  return work();
}

beforeAll(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url });
  await client.connect();

  /**
   * Its own workspaces rather than a clean database.
   *
   * This used to `TRUNCATE audit_log, tasks, workspace_members, workspaces
   * CASCADE`, which is a reasonable-looking way to start from a known state and
   * a bad one to do on a database other suites are using. `CASCADE` locks every
   * table referencing `workspaces` and removes their rows, so a test file
   * running alongside fails on an assertion about data that vanished — which
   * reads as flakiness rather than as interference, and cost real time to
   * diagnose.
   *
   * Unique ids need no cleanup and cannot collide. `audit_log` is append-only
   * by trigger, so leaving rows behind is the only option anyway.
   */
  await client.query("INSERT INTO workspaces (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING", [
    ALPHA,
    BETA,
  ]);
}, 30_000);

afterAll(async () => {
  if (!url) return;
  await client.end();
});

describeDb("row-level security holds in the database", () => {
  it("connects as a role that cannot bypass policies", async () => {
    const { rows } = await client.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    // If either were true this whole file would be theatre.
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it("lets a workspace read its own rows", async () => {
    await client.query("BEGIN");
    const found = await asWorkspace(ALPHA, async () => {
      await client.query(
        "INSERT INTO tasks (id, workspace_id, label) VALUES ($1, $2, 'Book dinner')",
        [T_ALPHA, ALPHA]
      );
      return client.query("SELECT id FROM tasks WHERE id = $1", [T_ALPHA]);
    });
    await client.query("COMMIT");

    expect(found.rows).toHaveLength(1);
  });

  /**
   * The property the whole multi-tenant story rests on. Note there is no WHERE
   * clause on workspace here — that is the point. A query that forgets its
   * filter must still return nothing.
   */
  it("returns nothing to a different workspace, with no filter in the query", async () => {
    await client.query("BEGIN");
    const seen = await asWorkspace(BETA, () => client.query("SELECT id FROM tasks"));
    await client.query("COMMIT");

    expect(seen.rows).toHaveLength(0);
  });

  it("refuses to write a row into someone else's workspace", async () => {
    await client.query("BEGIN");
    const attempt = asWorkspace(BETA, () =>
      client.query("INSERT INTO tasks (id, workspace_id, label) VALUES ($1, $2, 'Not mine')", [
        T_FORGED,
        ALPHA,
      ])
    );

    await expect(attempt).rejects.toThrow(/row-level security/iu);
    await client.query("ROLLBACK");
  });

  /**
   * With no workspace set, `current_setting(..., true)` is null and the policy
   * matches nothing. Failing closed here matters: a code path that forgot to set
   * the context should see an empty result, never everything.
   */
  it("shows nothing at all when no workspace has been set", async () => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', '', true)");
    const seen = await client.query("SELECT id FROM tasks");
    await client.query("COMMIT");

    expect(seen.rows).toHaveLength(0);
  });

  /**
   * Append-only, and *loudly* so.
   *
   * Two things had to be got right here and neither was obvious. Restrictive
   * policies, because permissive ones are OR'd and a `USING (false)` beside a
   * `FOR ALL` policy enforces nothing. And a trigger on top, because row-level
   * security filters rather than raises — without it the UPDATE succeeds having
   * matched no rows, and the caller is told it worked.
   */
  it("keeps the audit log append-only, even for its own workspace", async () => {
    await client.query("BEGIN");
    await asWorkspace(ALPHA, () =>
      client.query(
        `INSERT INTO audit_log (sequence, workspace_id, action, subject, at, previous_digest, digest)
         VALUES (1, $1, 'vault.fill', 'item-1', now(), '', 'abc')`,
        [ALPHA]
      )
    );
    await client.query("COMMIT");

    await client.query("BEGIN");
    const tamper = asWorkspace(ALPHA, () =>
      client.query("UPDATE audit_log SET subject = 'something-else' WHERE sequence = 1")
    );
    await expect(tamper).rejects.toThrow();
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    const erase = asWorkspace(ALPHA, () =>
      client.query("DELETE FROM audit_log WHERE sequence = 1")
    );
    await expect(erase).rejects.toThrow();
    await client.query("ROLLBACK");
  });
});
