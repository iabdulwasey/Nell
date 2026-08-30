/**
 * A one-shot, through the real claim-and-retire path.
 *
 * The unit tests cover deciding and staying quiet. What they cannot see is the
 * part that has silently killed features in this repository before: whether the
 * row is ever picked up. `claimDue` carried `AND every_minutes IS NOT NULL` —
 * written so that a one-shot would not appear among the standing schedules a
 * user typed — and with that clause in the *claim*, a follow-up could be written
 * and would simply never run. Built, tested, and reachable by nothing.
 *
 * So this drives the actual queries against the actual database: write one,
 * claim it, retire it, and prove it does not come back.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { accessScopeForUser, type AccessScope } from "@nell/shared";
import { withWorkspace } from "./db.js";
import {
  claimDue,
  completeRun,
  createFollowUp,
  createSchedule,
  listSchedules,
} from "./schedules.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;
let scope: AccessScope;

beforeAll(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });

  // A workspace id unique to this run: a shared one means one test's cleanup
  // deletes another test's rows, which is what caused a week of intermittent
  // failures nobody could reproduce.
  scope = accessScopeForUser(`follow-up-${String(process.pid)}-${String(Date.now())}`);
  await pool.query(`INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
    scope.workspaceId,
  ]);
});

afterAll(async () => {
  if (!url) return;
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [scope.workspaceId]).catch(() => {});
  await pool.end();
});

describeDb("a follow-up in the database", () => {
  it("is claimed when due, and retires instead of repeating", async () => {
    const now = Date.now();

    const id = await withWorkspace(pool, scope, (client) =>
      createFollowUp(client, scope, {
        label: "Sutro fog check",
        recheck: "Check current fog and wind over San Francisco.",
        runAt: now - 1000,
        original: "Shoot from Tank Hill at 5. Try 1/15 if the fog is ripping.",
        threadRef: "chat-1",
      })
    );

    const due = await withWorkspace(pool, scope, (client) => claimDue(client, scope, now));
    const claimed = due.find((row) => row.id === id);

    expect(
      claimed,
      "a follow-up that is never claimed is a feature that does nothing"
    ).toBeDefined();
    expect(claimed?.checkType).toBe("follow-up");
    // Undefined rather than a default: `?? 1440` would turn a one-shot daily.
    expect(claimed?.everyMinutes).toBeUndefined();
    // What makes the later message a correction rather than a second answer.
    expect(claimed?.config).toMatchObject({
      kind: "follow-up",
      original: expect.stringContaining("Tank Hill") as unknown as string,
    });

    await withWorkspace(pool, scope, (client) =>
      completeRun(client, scope, id, Date.now(), claimed?.everyMinutes)
    );

    // An hour later it must not come round again. A considerate second message
    // that repeats is a subscription nobody asked for.
    const later = await withWorkspace(pool, scope, (client) =>
      claimDue(client, scope, Date.now() + 60 * 60_000)
    );
    expect(later.map((row) => row.id)).not.toContain(id);
  });

  /**
   * The reason the claim filter existed. A one-shot the agent arranged for
   * itself is not a standing instruction the user set up, and listing it among
   * them would misdescribe both.
   */
  it("does not appear among the schedules the user set up", async () => {
    const now = Date.now();

    await withWorkspace(pool, scope, (client) =>
      createFollowUp(client, scope, {
        label: "hidden one-shot",
        recheck: "check",
        runAt: now + 60_000,
        original: "x",
        threadRef: "chat-1",
      })
    );
    await withWorkspace(pool, scope, (client) =>
      createSchedule(client, scope, {
        label: "morning briefing",
        prompt: "scan the news",
        everyMinutes: 1440,
        firstRunAt: now + 60_000,
        threadRef: "chat-1",
      })
    );

    const listed = await withWorkspace(pool, scope, (client) => listSchedules(client, scope));
    expect(listed.map((row) => row.label)).toEqual(["morning briefing"]);
  });

  it("is not claimed before it is due", async () => {
    const now = Date.now();
    const id = await withWorkspace(pool, scope, (client) =>
      createFollowUp(client, scope, {
        label: "not yet",
        recheck: "check",
        runAt: now + 60 * 60_000,
        original: "x",
        threadRef: "chat-1",
      })
    );

    const due = await withWorkspace(pool, scope, (client) => claimDue(client, scope, now));
    expect(due.map((row) => row.id)).not.toContain(id);
  });
});
