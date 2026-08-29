/**
 * Nell, actually working.
 *
 * A message arrives, a real model looks at a real page in a real browser through
 * the policy chokepoint, and a real row records what happened. Telegram is the
 * only thing stubbed, and only because the alternative is a test that needs a
 * human to type.
 *
 * This is the test that says the product works. Everything else says a part of it
 * behaves.
 *
 * Costs money and depends on a third party, so it is not in `pnpm check`. Run it
 * with `pnpm --filter @nell/core-app test:live`.
 */

import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BrowserExecutor } from "@nell/aegis";
import { keysFromEnv, type Capability } from "@nell/agent";
import { chromiumAvailable, LocalBrowserProvider } from "@nell/browser/adapters";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessScopeForUser } from "@nell/shared";
import { createPool, withWorkspace } from "./db.js";
import { handleMessage, type NellOptions } from "./nell.js";
import { WorkspaceSessions } from "./workspace-session.js";
import type { InboundMessage } from "./telegram-poll.js";

const keys = keysFromEnv(process.env);
const url = process.env["DATABASE_URL"];
const live = process.env["RUN_LIVE_MODEL_TESTS"] === "1";
const ready = live && Boolean(keys.anthropic) && Boolean(url) && chromiumAvailable();

const describeLive = ready ? describe : describe.skip;

/** A page with a fact worth extracting and a button that must not be pressed. */
const PAGE = `<!doctype html>
<html><head><title>Parcel tracking</title></head><body>
  <h1>Order A-1234</h1>
  <p id="status">Delivery status: out for delivery, arriving Thursday.</p>
  <button id="cancel">Cancel this order</button>
</body></html>`;

let server: Server;
let origin: string;
let pool: Pool;
let browser: LocalBrowserProvider;
let sessions: WorkspaceSessions;
let sent: string[] = [];
let options: NellOptions;

const ada = accessScopeForUser("ada");

/**
 * Reading tasks the way the application does — inside a workspace.
 *
 * The first version of this queried the pool directly and saw nothing, which
 * looked like the task never being written. It was row-level security doing its
 * job: without a workspace set, the policy matches no rows. Worth keeping as a
 * comment, because the symptom of RLS working is indistinguishable from the
 * symptom of a write failing.
 */
async function tasksOf(scope = ada) {
  return withWorkspace(pool, scope, async (client) => {
    const { rows } = await client.query<{ status: string }>("SELECT status FROM tasks");
    return rows;
  });
}

/** Telegram, without Telegram. Records what would have been said. */
const fakeTelegram: typeof fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
  if (String(input).includes("sendMessage") && body.text) sent.push(body.text);
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
};

function message(text: string, from = "111"): InboundMessage {
  return {
    envelope: {
      channel: "telegram",
      providerMessageId: `chat:${String(Math.abs(hash(text)))}`,
      threadRef: "chat",
      senderRef: from,
      text,
      receivedAt: Date.now(),
    },
    provenance: from === "111" ? "user" : "untrusted",
    userId: from === "111" ? "ada" : undefined,
    idempotencyKey: `telegram:chat:${String(Math.abs(hash(text)))}`,
  };
}

function hash(value: string): number {
  let out = 0;
  for (const character of value) out = (out * 31 + character.charCodeAt(0)) | 0;
  return out;
}

beforeAll(async () => {
  if (!ready) return;

  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  pool = createPool(url!);
  /**
   * No TRUNCATE. It used to wipe `workspaces CASCADE`, which locks every table
   * referencing it and deletes the rows of any test file running beside this
   * one — a victim that then fails on an assertion rather than on a lock, which
   * is why those failures read as random.
   */
  browser = new LocalBrowserProvider({ headless: true });
  sessions = new WorkspaceSessions({ provider: browser, startUrl: origin });
  options = {
    pool,
    browser,
    keys,
    modelId: "anthropic/claude-sonnet-4-5",
    telegramToken: "test-token",
    knownSenders: new Map([["111", "ada"]]),
    sessions,
    executor: new BrowserExecutor({ driver: browser }),
    fileRoot: mkdtempSync(join(tmpdir(), "nell-files-")),
    capabilities: new Set<Capability>(["browse"]),
    vendorKeys: new Set<string>(["anthropic"]),
  };

  // The stub replaces the network for Telegram only; the model and the browser
  // are real.
  globalThis.fetch = new Proxy(globalThis.fetch, {
    apply(target, thisArg, args: Parameters<typeof fetch>) {
      if (String(args[0]).includes("api.telegram.org")) {
        return fakeTelegram(...args);
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}, 120_000);

afterAll(async () => {
  if (!ready) return;

  await pool.end();
  await sessions.close();
  await browser.shutdown();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describeLive("Nell, end to end", () => {
  it("reads a page and answers the question it was asked", async () => {
    sent = [];
    const outcome = await handleMessage(
      options,
      message("When is order A-1234 arriving? Just tell me, do not change anything.")
    );

    expect(outcome?.ok, JSON.stringify(outcome)).toBe(true);
    expect(sent[0]).toBe("On it.");

    /**
     * The *last* message, not the transcript.
     *
     * This assertion used to run against `sent.join("\n")`, which includes every
     * streamed status line — so it passed while the agent was reaching the page,
     * mentioning the date in a progress note, and then signing off with a
     * description of where it had got to. Live, that looked like: asked for
     * today's headlines, replied "the user is already on Google News and can see
     * the top stories". The test was green throughout.
     *
     * What the user reads is the final message. Anything weaker than that
     * doesn't test the product.
     */
    const final = sent.at(-1) ?? "";
    expect(final.toLowerCase(), `final message was: ${final}`).toContain("thursday");

    // And on the mechanism, not only on the text: a reasoning line that happened
    // to mention the date would satisfy the assertion above while `answer` was
    // empty and the reply had fallen back to describing the work.
    const answer = outcome?.ok === true ? outcome.answer : "";
    expect(answer.toLowerCase(), "the answer field itself").toContain("thursday");

    const rows = await tasksOf();
    expect(rows[0]?.status).toBe("done");
  }, 180_000);

  /**
   * Small talk is not an objective.
   *
   * Observed live: a bare "Ok" opened a browser, ran a model call, and reported
   * that "Ok" did not specify an action.
   */
  it("does not open a browser for small talk", async () => {
    sent = [];
    const before = (await tasksOf()).length;

    const outcome = await handleMessage(options, message("Ok"));

    expect(outcome).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect((await tasksOf()).length).toBe(before);
  }, 30_000);

  /**
   * Anyone can message a Telegram bot. If inbound chat were trusted by default,
   * whoever found the username would have the agent's whole capability — and it
   * would look exactly like it was working.
   */
  it("answers a stranger and does no work for them", async () => {
    sent = [];
    const before = (await tasksOf()).length;

    const outcome = await handleMessage(options, message("Cancel that order", "999"));

    expect(outcome).toBeUndefined();
    expect(sent.join(" ")).toContain("only works for the person who set it up");

    expect((await tasksOf()).length).toBe(before);
  }, 60_000);

  /** Silence from something plainly online reads as broken and invites retrying. */
  it("says it has started before it starts", async () => {
    sent = [];
    await handleMessage(options, message("What does the page say?"));
    expect(sent[0]).toBe("On it.");
  }, 180_000);
});
