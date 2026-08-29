/**
 * The heartbeat, against a real database and fake everything else.
 *
 * The browser and the model are stubbed because neither is what is under test:
 * what matters is that a due schedule runs, that a repeat stays quiet, and that
 * a failure still reschedules. The last one is the important one — it is the
 * difference between a schedule that fails tonight and a schedule that retries
 * every five minutes forever.
 */

import type { BrowserExecutor } from "@nell/aegis";
import type { ModelProvider } from "@nell/agent";
import type { BrowserProvider } from "@nell/browser";
import { accessScopeForUser } from "@nell/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, withWorkspace } from "./db.js";
import { claimDue, createSchedule } from "./schedules.js";
import { tickOnce, type TickerDeps } from "./ticker.js";
import { WorkspaceSessions } from "./workspace-session.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;
const ada = accessScopeForUser("tick-ada");
const NOON = new Date(2026, 7, 29, 12, 0, 0).getTime();

/** Just enough browser for the loop to take one look and stop. */
function fakeBrowser(onSnapshot?: () => void): BrowserProvider {
  return {
    createSession: async () => ({ id: "s1", workspaceId: ada.workspaceId }),
    snapshot: async () => {
      onSnapshot?.();
      return { url: "https://example.com", title: "t", nodes: [], text: "", truncated: false };
    },
    destroy: async () => undefined,
  } as unknown as BrowserProvider;
}

/** A model that finishes immediately with whatever answer it is given. */
function fakeModel(answer: string): ModelProvider {
  return {
    name: "stub",
    complete: async () => ({
      ok: true,
      value: { reasoning: "done", actions: [], done: true, answer, search: "" },
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  } as unknown as ModelProvider;
}

function deps(overrides: Partial<TickerDeps> & { sent: string[] }): TickerDeps {
  const browser = overrides.browser ?? fakeBrowser();
  return {
    pool,
    browser,
    sessions: new WorkspaceSessions({ provider: browser }),
    executor: {} as BrowserExecutor,
    model: overrides.model ?? fakeModel("Nepal floods; Modi in Central Asia"),
    modelId: "test",
    send: async (_thread, text) => {
      overrides.sent.push(text);
    },
    ...overrides,
  };
}

async function seed(at = NOON, everyMinutes = 1440) {
  return withWorkspace(pool, ada, (client) =>
    createSchedule(client, ada, {
      label: "AI news",
      prompt: "Find today's AI news.",
      everyMinutes,
      firstRunAt: at,
      threadRef: "chat-1",
    })
  );
}

/**
 * Reset, and re-create the workspace.
 *
 * Another suite in the same run truncates `workspaces CASCADE`, which takes this
 * one's rows with it — so a workspace created once in `beforeAll` is gone by the
 * time a later test needs it, and the failure is a foreign-key violation three
 * files away from its cause. Making setup idempotent is cheaper than making
 * suites agree about who owns the database.
 */
async function wipe() {
  await withWorkspace(pool, ada, async (client) => {
    await client.query("DELETE FROM monitor_reports");
    await client.query("DELETE FROM monitors");
    await client.query("INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING", [
      ada.workspaceId,
    ]);
  });
}

beforeAll(async () => {
  if (!url) return;
  pool = createPool(url);
  await withWorkspace(pool, ada, async (client) => {
    await client.query("INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING", [
      ada.workspaceId,
    ]);
  });
});

beforeEach(async () => {
  if (!url) return;
  await wipe();
});

afterAll(async () => {
  if (!url) return;
  await wipe();
  await pool.end();
});

describeDb("the ticker", () => {
  it("runs a due schedule and sends what it found", async () => {
    await seed(NOON);
    const sent: string[] = [];

    const ran = await tickOnce(deps({ sent }), ada, NOON);

    expect(ran).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Nepal floods");
    // Labelled, so a message arriving unprompted says why it arrived.
    expect(sent[0]).toContain("AI news");
  });

  it("does nothing when nothing is due", async () => {
    await seed(NOON);
    const sent: string[] = [];

    expect(await tickOnce(deps({ sent }), ada, NOON - 60_000)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  /**
   * A daily scan that finds yesterday's page is not news. Repeating it teaches
   * the user to ignore the notification, which costs them the one that matters.
   */
  it("stays quiet when it finds the same thing again", async () => {
    await seed(NOON, 15);
    const sent: string[] = [];
    let clock = NOON;
    const shared = deps({ sent, clock: () => clock });

    const first = await tickOnce(shared, ada, clock);
    clock = NOON + 20 * 60_000;
    const second = await tickOnce(shared, ada, clock);

    // Both ticks genuinely ran. Asserting only on `sent` would pass just as
    // happily if the second tick had claimed nothing — which is exactly what it
    // was doing before the clock was injected.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("speaks up when the result actually changes", async () => {
    await seed(NOON, 15);
    const sent: string[] = [];
    const browser = fakeBrowser();
    const sessions = new WorkspaceSessions({ provider: browser });
    let clock = NOON;
    const at = (model: ModelProvider) =>
      deps({ sent, browser, sessions, model, clock: () => clock });

    await tickOnce(at(fakeModel("monday")), ada, clock);
    clock = NOON + 20 * 60_000;
    await tickOnce(at(fakeModel("tuesday")), ada, clock);

    expect(sent).toHaveLength(2);
  });

  /**
   * The one that matters. Left leased, a failed run retries the moment the lease
   * expires — so a schedule whose site is down becomes a five-minute retry loop
   * instead of a task that failed once and will try again tomorrow.
   */
  it("reschedules even when the run throws", async () => {
    await seed(NOON);
    const sent: string[] = [];
    const exploding = fakeBrowser(() => {
      throw new Error("the page fell over");
    });

    await tickOnce(deps({ sent, browser: exploding, clock: () => NOON }), ada, NOON);

    // Not owed again five minutes later, when the lease would have lapsed.
    const soon = await withWorkspace(pool, ada, (client) =>
      claimDue(client, ada, NOON + 6 * 60_000)
    );
    expect(soon).toHaveLength(0);
  });

  /**
   * A briefing that silently stops arriving is indistinguishable from one that
   * had nothing to say, and the user cannot tell which without asking.
   */
  it("says so when a run fails", async () => {
    await seed(NOON);
    const sent: string[] = [];
    const failing: ModelProvider = {
      name: "stub",
      complete: async () => ({ ok: false, reason: "model is down", retryable: true }),
    } as unknown as ModelProvider;

    await tickOnce(deps({ sent, model: failing }), ada, NOON);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("AI news");
  });
});
