/**
 * The claim under test: state survives between tasks.
 *
 * That is the whole reason the session is held open, and it is the sort of claim
 * that is easy to make in a comment and never check. Against a real Chromium,
 * because the thing being tested is whether a browser context is still the same
 * browser context — a fake provider would prove only that a Map holds a value.
 */

import { chromiumAvailable, LocalBrowserProvider } from "@nell/browser/adapters";
import { accessScopeForUser } from "@nell/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceSessions } from "./workspace-session.js";

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

let browser: LocalBrowserProvider;

const ada = accessScopeForUser("ada");
const bob = accessScopeForUser("bob");

beforeAll(() => {
  if (!chromiumAvailable()) return;
  browser = new LocalBrowserProvider({ headless: true });
});

afterAll(async () => {
  if (!chromiumAvailable()) return;
  await browser.shutdown();
});

describeBrowser("the workspace's browser", () => {
  it("is the same browser on the next task, still where the last one left it", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });

    const first = await sessions.acquire(ada);
    await browser.perform(ada, first.id, [
      { action: "goto", url: "https://example.com", waitUntil: "domcontentloaded" },
    ]);

    const second = await sessions.acquire(ada);
    expect(second.id).toBe(first.id);

    // The load-bearing assertion: not that the handle matches, but that the page
    // did not go back to a start screen. A task that has to re-navigate every
    // time has re-logged-in every time too.
    const snapshot = await browser.snapshot(ada, second.id);
    expect(snapshot.url).toContain("example.com");

    await sessions.close();
  }, 60_000);

  it("gives a different workspace a different browser", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });

    const hers = await sessions.acquire(ada);
    const his = await sessions.acquire(bob);

    expect(his.id).not.toBe(hers.id);

    await sessions.close();
  }, 60_000);

  /**
   * The risky path. A session dies for reasons nobody chose — the browser
   * crashes, a context is closed, the machine is swept — and the cost lands on
   * whoever happens to send the next message. Failing their task because of a
   * browser opened yesterday would be someone else's problem presented as
   * theirs.
   */
  it("reopens after the session dies underneath it", async () => {
    const sessions = new WorkspaceSessions({ provider: browser });

    const first = await sessions.acquire(ada);
    // Killed behind the pool's back, which is exactly how it happens for real.
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
