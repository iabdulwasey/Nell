/**
 * A task that spans more than one message.
 *
 * "How would you decide one task ends?" — it did not. Every message was a task:
 * a row, an "On it", a ledger entry. So one booking conversation wrote three
 * tasks for one goal, and two of them were fragments like "Heathrow".
 *
 * The piece that was missing is small and was the whole problem: **a parked task
 * did not record what it had asked.** Without the question there is no way to
 * judge whether the next message answers it, so only two answers could ever
 * resume anything — a yes to a payment and a place name, because those were the
 * two the code recognised by shape. Every other question stranded its task.
 */

import { accessScopeForUser } from "@nell/shared";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, withWorkspace } from "./db.js";
import { abandon, park, peek, unpark } from "./pending-task.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;

async function workspace() {
  const scope = accessScopeForUser(`park-${randomUUID()}`);
  await withWorkspace(pool, scope, (client) =>
    client.query("INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING", [
      scope.workspaceId,
    ])
  );
  return scope;
}

const status = async (scope: ReturnType<typeof accessScopeForUser>, id: string) => {
  const { rows } = await withWorkspace(pool, scope, (client) =>
    client.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [id])
  );
  return rows[0]?.status;
};

beforeAll(() => {
  if (!url) return;
  pool = createPool(url);
});

afterAll(async () => {
  if (!url) return;
  await pool.end();
});

describeDb("parking on a question", () => {
  it("remembers what it asked, which is what makes an answer recognisable", async () => {
    const scope = await workspace();
    const id = randomUUID();

    await withWorkspace(pool, scope, (client) =>
      park(client, scope, {
        id,
        objective: "book a flight to Delhi on 3 September",
        threadRef: "chat-1",
        question: "Which airport — Heathrow or Gatwick?",
      })
    );

    const waiting = await withWorkspace(pool, scope, (client) => peek(client, scope));

    expect(waiting?.question).toBe("Which airport — Heathrow or Gatwick?");
    // The goal, not the fragment: this is what gets resumed and worked on.
    expect(waiting?.objective).toBe("book a flight to Delhi on 3 September");
    expect(waiting?.threadRef).toBe("chat-1");
  });

  it("parks without a question, since not every stop is one", async () => {
    const scope = await workspace();
    await withWorkspace(pool, scope, (client) =>
      park(client, scope, { id: randomUUID(), objective: "buy the tickets", threadRef: "chat-1" })
    );

    const waiting = await withWorkspace(pool, scope, (client) => peek(client, scope));
    expect(waiting?.question).toBeUndefined();
  });

  it("replaces an earlier question rather than queueing behind it", async () => {
    const scope = await workspace();
    const first = randomUUID();

    await withWorkspace(pool, scope, async (client) => {
      await park(client, scope, {
        id: first,
        objective: "one",
        threadRef: "chat-1",
        question: "Which airport?",
      });
      await park(client, scope, {
        id: randomUUID(),
        objective: "two",
        threadRef: "chat-1",
        question: "Which hotel?",
      });
    });

    // One open question over one flat thread: a second replaces the first,
    // because guessing which of two a bare "Heathrow" answers is how a reply
    // lands on the wrong task.
    const waiting = await withWorkspace(pool, scope, (client) => peek(client, scope));
    expect(waiting?.question).toBe("Which hotel?");
    expect(await status(scope, first)).toBe("cancelled");
  });
});

describeDb("how a parked task ends", () => {
  it("resumes when the answer arrives", async () => {
    const scope = await workspace();
    const id = randomUUID();

    await withWorkspace(pool, scope, (client) =>
      park(client, scope, {
        id,
        objective: "book a flight",
        threadRef: "c",
        question: "Which airport?",
      })
    );
    await withWorkspace(pool, scope, (client) => unpark(client, scope, id));

    expect(await status(scope, id)).toBe("running");
    // And nothing is left waiting, so the next message is judged fresh.
    expect(await withWorkspace(pool, scope, (client) => peek(client, scope))).toBeUndefined();
  });

  /**
   * `abandoned`, not `failed` and not `cancelled`.
   *
   * Nobody said stop and nothing broke — they asked about something else and
   * never came back, which is an ordinary thing people do. Recording it as a
   * failure puts a fault in the history that nobody committed, and the history
   * is what "have we done this before" reads from.
   */
  it("is abandoned when the user moves on, which is not a failure", async () => {
    const scope = await workspace();
    const id = randomUUID();

    await withWorkspace(pool, scope, (client) =>
      park(client, scope, {
        id,
        objective: "book a flight",
        threadRef: "c",
        question: "Which airport?",
      })
    );

    expect(await withWorkspace(pool, scope, (client) => abandon(client, scope, id))).toBe(true);
    expect(await status(scope, id)).toBe("abandoned");
    expect(await withWorkspace(pool, scope, (client) => peek(client, scope))).toBeUndefined();
  });

  /** Only a blocked task can be abandoned — a finished one is not up for grabs. */
  it("will not abandon a task that was not waiting on anything", async () => {
    const scope = await workspace();
    const id = randomUUID();

    await withWorkspace(pool, scope, (client) =>
      client.query(
        `INSERT INTO tasks (id, workspace_id, label, status) VALUES ($1, $2, 'done already', 'done')`,
        [id, scope.workspaceId]
      )
    );

    expect(await withWorkspace(pool, scope, (client) => abandon(client, scope, id))).toBe(false);
    expect(await status(scope, id)).toBe("done");
  });

  it("does not let one workspace abandon another's task", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const id = randomUUID();

    await withWorkspace(pool, mine, (client) =>
      park(client, mine, { id, objective: "mine", threadRef: "c", question: "Which?" })
    );

    expect(await withWorkspace(pool, theirs, (client) => abandon(client, theirs, id))).toBe(false);
    expect(await status(mine, id)).toBe("blocked-on-user");
  });
});
