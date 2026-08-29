/**
 * The vertical slice, end to end.
 *
 * A request becomes a persisted row, the row becomes a real Chromium session,
 * the session is driven through the policy chokepoint, and the outcome is
 * written back — against a real Postgres, as a role that cannot bypass
 * row-level security.
 *
 * This is the test the other thousand cannot replace. They establish that each
 * part behaves when called correctly; only this one establishes that the parts
 * fit, that the sequence survives a failure halfway through, and that the
 * guarantees each part proves in isolation still hold once they are composed.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserExecutor } from "@nell/aegis";
import { chromiumAvailable, LocalBrowserProvider } from "@nell/browser/adapters";
import { accessScopeForUser } from "@nell/shared";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRlsEnforceable, createPool } from "./db.js";
import { listTasks, runTask, type RunnerDeps } from "./runner.js";

const url = process.env["DATABASE_URL"];
const chromiumReady = chromiumAvailable();

const describeSlice = url && chromiumReady ? describe : describe.skip;

const PAGE = `<!doctype html><html><body>
  <h1 id="title">Order A-1234</h1>
  <div id="status">Delivery status: shipped</div>
</body></html>`;

let server: Server;
let origin: string;
let pool: Pool;
let deps: RunnerDeps;

/**
 * A workspace nobody else will use, rather than a shared name plus a TRUNCATE.
 *
 * This file used to `TRUNCATE tasks, workspace_members, workspaces CASCADE`
 * between runs, which is two problems wearing one statement. `CASCADE` takes an
 * ACCESS EXCLUSIVE lock on every table referencing `workspaces` — by now that is
 * most of the schema — so any test file running in parallel deadlocks against
 * it. And it *deletes their rows*, which is worse: the victim does not fail with
 * a lock error, it fails with an assertion about data that was there a moment
 * ago. That is what the intermittent failures elsewhere in this suite were.
 *
 * Unique ids per run need no cleanup and cannot collide, so nothing has to be
 * taken away from anyone.
 */
/**
 * Ids unique to this run — workspaces *and* tasks.
 *
 * The task ids matter for the same reason the workspace ids do. With no
 * TRUNCATE, a fixed `task-1` collides with the row a previous run left behind,
 * and the `ON CONFLICT (id) DO UPDATE` in `createTask` then tries to update a
 * row belonging to a different workspace — which row-level security correctly
 * refuses. The isolation was working; the test was relying on a wipe.
 */
const runId = randomUUID();
const scope = accessScopeForUser(`user-slice-${runId}`);
const other = accessScopeForUser(`user-elsewhere-${runId}`);

beforeAll(async () => {
  if (!url || !chromiumReady) return;

  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  pool = createPool(url);
  // If this passes as a superuser the whole suite is theatre.
  await assertRlsEnforceable(pool);

  await pool.query("INSERT INTO workspaces (id) VALUES ($1), ($2)", [
    scope.workspaceId,
    other.workspaceId,
  ]);

  const provider = new LocalBrowserProvider({ headless: true });
  deps = {
    pool,
    provider,
    executor: new BrowserExecutor({ driver: provider }),
    now: () => Date.now(),
  };
}, 120_000);

afterAll(async () => {
  if (!url || !chromiumReady) return;
  await pool.query("DELETE FROM tasks WHERE workspace_id = ANY($1)", [
    [scope.workspaceId, other.workspaceId],
  ]);
  await pool.end();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describeSlice("a task, from request to persisted outcome", () => {
  it("runs, reads the page, and records that it finished", async () => {
    const result = await runTask(deps, {
      scope,
      id: `task-1-${runId}`,
      label: "Track order A-1234",
      startUrl: origin,
      provenance: "user",
      actions: [{ action: "extract", fields: ["text"] }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extracted?.["text"]).toContain("Delivery status: shipped");

    const tasks = await listTasks(pool, scope);
    expect(tasks).toContainEqual({
      id: `task-1-${runId}`,
      label: "Track order A-1234",
      status: "done",
    });
  }, 120_000);

  /**
   * The gate is consulted before a browser is opened, because a refusal after
   * opening one has already cost what the refusal was meant to save.
   */
  it("refuses a task whose only basis is untrusted content, before opening a browser", async () => {
    const result = await runTask(deps, {
      scope,
      id: `task-injected-${runId}`,
      label: "Do what the email said",
      startUrl: origin,
      provenance: "untrusted",
      actions: [{ action: "extract", fields: ["text"] }],
    });

    expect(result.ok).toBe(false);

    // No row at all: the refusal happened before anything was written.
    const tasks = await listTasks(pool, scope);
    expect(tasks.map((task) => task.id)).not.toContain(`task-injected-${runId}`);
  }, 60_000);

  /**
   * A row stuck in `running` forever is worse than one marked `failed` — it
   * looks like work in progress, so nothing retries it and nobody investigates.
   */
  it("marks a task failed rather than leaving it running", async () => {
    const result = await runTask(deps, {
      scope,
      id: `task-broken-${runId}`,
      label: "Visit somewhere unreachable",
      startUrl: "http://127.0.0.1:1/nowhere",
      provenance: "user",
      actions: [{ action: "extract", fields: ["text"] }],
    });

    expect(result.ok).toBe(false);

    const tasks = await listTasks(pool, scope);
    expect(tasks.find((task) => task.id === `task-broken-${runId}`)?.status).toBe("failed");
  }, 120_000);

  /**
   * The composed property. Tenant isolation was proved against the database and
   * the runner never writes a WHERE clause for it — so if `withWorkspace` were
   * wired up wrongly, this is where it would show.
   */
  it("does not show one workspace's tasks to another", async () => {
    const theirs = await listTasks(pool, other);
    expect(theirs).toEqual([]);

    const mine = await listTasks(pool, scope);
    expect(mine.length).toBeGreaterThan(0);
  }, 60_000);
});
