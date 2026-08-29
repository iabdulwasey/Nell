/**
 * Scheduling, against a real database.
 *
 * Everything interesting here is SQL — leasing, rescheduling, and a uniqueness
 * constraint used as a decision procedure — and none of it can be tested
 * against an in-memory array without testing the array instead. Run as the
 * unprivileged application role, so row-level security is in force exactly as
 * it is in production.
 */

import { accessScopeForUser } from "@nell/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, withWorkspace } from "./db.js";
import {
  cancelAll,
  claimDue,
  completeRun,
  createSchedule,
  listSchedules,
  recordIfNew,
} from "./schedules.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;
const ada = accessScopeForUser("sched-ada");
const bob = accessScopeForUser("sched-bob");

const NOON = new Date(2026, 7, 29, 12, 0, 0).getTime();
const MINUTE = 60_000;

async function seed(scope = ada, at = NOON, label = "AI news") {
  return withWorkspace(pool, scope, (client) =>
    createSchedule(client, scope, {
      label,
      prompt: "Find today's AI news.",
      everyMinutes: 1440,
      firstRunAt: at,
      threadRef: "chat-1",
    })
  );
}

beforeAll(async () => {
  if (!url) return;
  pool = createPool(url);
  for (const scope of [ada, bob]) {
    await withWorkspace(pool, scope, async (client) => {
      await client.query("INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING", [
        scope.workspaceId,
      ]);
    });
  }
});

/**
 * Cleanup has to happen inside a workspace too.
 *
 * The first version used `pool.query` directly and deleted nothing at all —
 * without a workspace set, the policy matches no rows, so rows accumulated
 * across tests and counts drifted. That is row-level security working, and its
 * symptom is indistinguishable from a delete that failed.
 */
async function wipe() {
  for (const scope of [ada, bob]) {
    await withWorkspace(pool, scope, async (client) => {
      await client.query("DELETE FROM monitor_reports");
      await client.query("DELETE FROM monitors");
    });
  }
}

beforeEach(async () => {
  if (!url) return;
  await wipe();
});

afterAll(async () => {
  if (!url) return;
  await wipe();
  await pool.end();
});

describeDb("scheduling", () => {
  it("does not run before it is due", async () => {
    await seed(ada, NOON);
    const early = await withWorkspace(pool, ada, (client) => claimDue(client, ada, NOON - MINUTE));
    expect(early).toHaveLength(0);
  });

  it("runs once it is due, and carries what it needs to run", async () => {
    await seed(ada, NOON);
    const due = await withWorkspace(pool, ada, (client) => claimDue(client, ada, NOON));

    expect(due).toHaveLength(1);
    expect(due[0]?.prompt).toBe("Find today's AI news.");
    expect(due[0]?.threadRef).toBe("chat-1");
    expect(due[0]?.everyMinutes).toBe(1440);
  });

  /**
   * The lease is what stops two processes running the same schedule — and, more
   * commonly, one process running it twice because a tick overlapped the last.
   * For something that texts you, that is two identical 6am briefings.
   */
  it("does not hand the same schedule out twice", async () => {
    await seed(ada, NOON);

    const first = await withWorkspace(pool, ada, (client) => claimDue(client, ada, NOON));
    const second = await withWorkspace(pool, ada, (client) => claimDue(client, ada, NOON));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  /** A process that dies mid-run must not retire the schedule forever. */
  it("hands it out again once the lease expires", async () => {
    await seed(ada, NOON);
    await withWorkspace(pool, ada, (client) => claimDue(client, ada, NOON));

    const later = await withWorkspace(pool, ada, (client) =>
      claimDue(client, ada, NOON + 6 * MINUTE)
    );
    expect(later).toHaveLength(1);
  });

  /**
   * Rescheduled from now, not from when the run was due.
   *
   * A process down for three days must not come back and fire three briefings
   * back to back. The catch-up storm is the classic version of this bug and its
   * symptom is a burst of messages at once.
   */
  it("schedules the next run from now, so downtime does not stack up", async () => {
    const id = await seed(ada, NOON);
    await withWorkspace(pool, ada, (client) => claimDue(client, ada, NOON));

    const threeDaysLate = NOON + 3 * 24 * 60 * MINUTE;
    await withWorkspace(pool, ada, (client) => completeRun(client, ada, id, threeDaysLate, 1440));

    // Nothing is owed at the moment it completes...
    const immediately = await withWorkspace(pool, ada, (client) =>
      claimDue(client, ada, threeDaysLate + MINUTE)
    );
    expect(immediately).toHaveLength(0);

    // ...and exactly one run is due a day later, not three.
    const tomorrow = await withWorkspace(pool, ada, (client) =>
      claimDue(client, ada, threeDaysLate + 1441 * MINUTE)
    );
    expect(tomorrow).toHaveLength(1);
  });

  it("keeps one workspace's schedules away from another", async () => {
    await seed(ada, NOON);

    const hers = await withWorkspace(pool, bob, (client) => claimDue(client, bob, NOON));
    expect(hers).toHaveLength(0);

    const listed = await withWorkspace(pool, bob, (client) => listSchedules(client, bob));
    expect(listed).toHaveLength(0);
  });

  it("stops what the user asks it to stop", async () => {
    await seed(ada, NOON);
    const stopped = await withWorkspace(pool, ada, (client) => cancelAll(client, ada));

    expect(stopped).toBe(1);
    expect(await withWorkspace(pool, ada, (client) => claimDue(client, ada, NOON))).toHaveLength(0);
    expect(await withWorkspace(pool, ada, (client) => listSchedules(client, ada))).toHaveLength(0);
  });

  /**
   * The uniqueness constraint decides, not a read followed by a write. Two ticks
   * racing on the same content would both see "not reported yet" and both send.
   */
  describe("not saying the same thing twice", () => {
    it("reports new content and stays quiet about a repeat", async () => {
      const id = await seed(ada, NOON);

      const first = await withWorkspace(pool, ada, (client) =>
        recordIfNew(client, ada, id, "Nepal floods; Modi in Central Asia")
      );
      const again = await withWorkspace(pool, ada, (client) =>
        recordIfNew(client, ada, id, "Nepal floods; Modi in Central Asia")
      );

      expect(first).toBe(true);
      expect(again).toBe(false);
    });

    it("reports again when the content actually changes", async () => {
      const id = await seed(ada, NOON);
      await withWorkspace(pool, ada, (client) => recordIfNew(client, ada, id, "yesterday"));

      expect(
        await withWorkspace(pool, ada, (client) => recordIfNew(client, ada, id, "today"))
      ).toBe(true);
    });

    it("does not confuse two schedules that found the same thing", async () => {
      const news = await seed(ada, NOON, "news");
      const other = await seed(ada, NOON, "other");

      expect(await withWorkspace(pool, ada, (c) => recordIfNew(c, ada, news, "same"))).toBe(true);
      expect(await withWorkspace(pool, ada, (c) => recordIfNew(c, ada, other, "same"))).toBe(true);
    });
  });
});
