/**
 * The claim under test, in two halves.
 *
 * Cookies and logins survive between tasks — that is the whole reason the
 * session is held open. The *page* does not, and that half was learned the hard
 * way: a task ended on a site showing a wall, the next message asked about
 * somewhere else entirely, and the answer came back about the first site,
 * because the first thing the new task saw was the old task's page.
 *
 * Against real Chromium and a real server, because the thing being tested is
 * whether a browser context is still the same browser context. A fake provider
 * would prove only that a Map holds a value.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromiumAvailable, LocalBrowserProvider } from "@nell/browser/adapters";
import { accessScopeForUser } from "@nell/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceSessions } from "./workspace-session.js";

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

let browser: LocalBrowserProvider;
let server: Server;
let origin: string;

const ada = accessScopeForUser("ws-ada");
const bob = accessScopeForUser("ws-bob");

/**
 * Sets a cookie on the first visit and reports on every visit whether it was
 * sent back. This is what "still logged in" means, reduced to one bit.
 */
beforeAll(async () => {
  if (!chromiumAvailable()) return;

  server = createServer((req, res) => {
    const seen = (req.headers.cookie ?? "").includes("nell=remembered");
    res.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "nell=remembered; Path=/; SameSite=Lax",
    });
    res.end(`<!doctype html><title>Session probe</title><h1>${seen ? "KNOWN" : "STRANGER"}</h1>`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  browser = new LocalBrowserProvider({ headless: true });
});

afterAll(async () => {
  if (!chromiumAvailable()) return;
  await browser.shutdown();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

async function visit(sessionId: string): Promise<string> {
  await browser.perform(ada, sessionId, [
    { action: "goto", url: origin, waitUntil: "domcontentloaded" },
  ]);
  return (await browser.snapshot(ada, sessionId)).text ?? "";
}

describeBrowser("the workspace's browser", () => {
  /**
   * The property worth having, stated precisely.
   *
   * Not "the page is still there" — that was the first version of this test, and
   * it asserted the thing that turned out to be the bug. What must survive is
   * the context: a site the agent signed into last task still knows it.
   */
  it("is still logged in on the next task", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });

    const first = await sessions.acquire(ada);
    expect(await visit(first.id)).toContain("STRANGER");

    const second = await sessions.acquire(ada);
    expect(second.id).toBe(first.id);
    expect(await visit(second.id)).toContain("KNOWN");

    await sessions.close();
  }, 60_000);

  /**
   * And the half that must not survive. A new task starting on the previous
   * task's page is how "check google" got answered with a report about
   * BookMyShow — the agent never navigated, and was judged on what was left
   * behind.
   */
  it("gives each task a fresh page", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });

    const first = await sessions.acquire(ada);
    await visit(first.id);
    expect((await browser.snapshot(ada, first.id)).url).toContain("127.0.0.1");

    await sessions.acquire(ada);
    expect((await browser.snapshot(ada, first.id)).url).not.toContain("127.0.0.1");

    await sessions.close();
  }, 60_000);

  /** One workspace's logins must never be another's. */
  it("gives a different workspace a different browser", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });

    const hers = await sessions.acquire(ada);
    await visit(hers.id);

    const his = await sessions.acquire(bob);
    expect(his.id).not.toBe(hers.id);

    await browser.perform(bob, his.id, [
      { action: "goto", url: origin, waitUntil: "domcontentloaded" },
    ]);
    expect((await browser.snapshot(bob, his.id)).text ?? "").toContain("STRANGER");

    await sessions.close();
  }, 60_000);

  /**
   * A session dies for reasons nobody chose — the browser crashes, a context is
   * closed. The cost lands on whoever happens to send the next message, and
   * failing their task over a browser opened yesterday makes someone else's
   * problem look like theirs.
   */
  it("reopens after the session dies underneath it", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });

    const first = await sessions.acquire(ada);
    await browser.destroy(ada, first.id);

    const second = await sessions.acquire(ada);
    expect(second.id).not.toBe(first.id);
    await expect(browser.snapshot(ada, second.id)).resolves.toBeDefined();

    await sessions.close();
  }, 60_000);

  it("closes what it opened", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });
    const session = await sessions.acquire(ada);

    await sessions.close();

    await expect(browser.snapshot(ada, session.id)).rejects.toThrow();
  }, 60_000);
});
