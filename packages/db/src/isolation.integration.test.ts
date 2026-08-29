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

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let client: pg.Client;

async function asWorkspace<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
  await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
  return work();
}

beforeAll(async () => {
  if (!url) return;
  client = new pg.Client({ connectionString: url });
  await client.connect();

  /**
   * Start from empty rather than hoping the last run tidied up. A test that
   * needs a clean database and does not make one is a test that passes until
   * the first time something else fails.
   *
   * TRUNCATE, not DELETE, because audit_log refuses DELETE — deliberately. The
   * line drawn is between an *application* rewriting history, which is the
   * attack, and an *operator* wiping a database they own, which is a different
   * act requiring different rights. Blocking both would make the table
   * impossible to test against and would not stop anyone who could drop the
   * trigger anyway.
   */
  await client.query("TRUNCATE audit_log, tasks, workspace_members, workspaces CASCADE");
  await client.query(
    "INSERT INTO workspaces (id) VALUES ('ws-alpha'), ('ws-beta') ON CONFLICT DO NOTHING"
  );
}, 30_000);

afterAll(async () => {
  if (!url) return;
  await client.query("TRUNCATE audit_log, tasks, workspace_members, workspaces CASCADE");
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
    const found = await asWorkspace("ws-alpha", async () => {
      await client.query(
        "INSERT INTO tasks (id, workspace_id, label) VALUES ('t-alpha', 'ws-alpha', 'Book dinner')"
      );
      return client.query("SELECT id FROM tasks WHERE id = 't-alpha'");
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
    const seen = await asWorkspace("ws-beta", () => client.query("SELECT id FROM tasks"));
    await client.query("COMMIT");

    expect(seen.rows).toHaveLength(0);
  });

  it("refuses to write a row into someone else's workspace", async () => {
    await client.query("BEGIN");
    const attempt = asWorkspace("ws-beta", () =>
      client.query(
        "INSERT INTO tasks (id, workspace_id, label) VALUES ('t-forged', 'ws-alpha', 'Not mine')"
      )
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
    await asWorkspace("ws-alpha", () =>
      client.query(
        `INSERT INTO audit_log (sequence, workspace_id, action, subject, at, previous_digest, digest)
         VALUES (1, 'ws-alpha', 'vault.fill', 'item-1', now(), '', 'abc')`
      )
    );
    await client.query("COMMIT");

    await client.query("BEGIN");
    const tamper = asWorkspace("ws-alpha", () =>
      client.query("UPDATE audit_log SET subject = 'something-else' WHERE sequence = 1")
    );
    await expect(tamper).rejects.toThrow();
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    const erase = asWorkspace("ws-alpha", () =>
      client.query("DELETE FROM audit_log WHERE sequence = 1")
    );
    await expect(erase).rejects.toThrow();
    await client.query("ROLLBACK");
  });
});
