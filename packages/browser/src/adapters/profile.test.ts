/**
 * The profile that outlives the process.
 *
 * A session held open in memory keeps a login until the process ends, and the
 * process ends often — every deploy, every crash, every restart. Instinct's
 * machine is valuable precisely because it is *old*: the cookies, the storage
 * and the history accumulate, and a site that has seen the device before asks
 * fewer questions. None of that survives a restart unless the profile is on
 * disk.
 *
 * So the test is a restart. Not a second session, not a second context — a
 * second `LocalBrowserProvider`, which is what the next run of the process
 * actually is.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessScopeForUser } from "@nell/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumAvailable } from "./computer-exec.js";
import { LocalBrowserProvider } from "./local.js";

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

let server: Server;
let origin: string;
let root: string;

const ada = accessScopeForUser("profile-ada");
const bob = accessScopeForUser("profile-bob");

beforeAll(async () => {
  if (!chromiumAvailable()) return;

  // Sets a cookie on first sight, and reports on every visit whether it was
  // sent back — "does this site know me" reduced to one bit.
  server = createServer((req, res) => {
    const known = (req.headers.cookie ?? "").includes("nell=known");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "nell=known; Path=/; Max-Age=86400; SameSite=Lax",
    });
    res.end(`<!doctype html><title>Probe</title><h1>${known ? "KNOWN" : "STRANGER"}</h1>`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  root = mkdtempSync(join(tmpdir(), "nell-profiles-"));
});

afterAll(() => {
  if (!chromiumAvailable()) return;
  rmSync(root, { recursive: true, force: true });
  server.close();
});

async function visit(browser: LocalBrowserProvider, scope = ada): Promise<string> {
  const session = await browser.createSession(scope, { startUrl: origin });
  const text = (await browser.snapshot(scope, session.id)).text ?? "";
  await browser.shutdown();
  return text;
}

describeBrowser("a browser profile on disk", () => {
  it("is still logged in after the process restarts", async () => {
    // First run of the process.
    const first = new LocalBrowserProvider({ headless: true, profileRoot: root });
    expect(await visit(first)).toContain("STRANGER");

    // An entirely new provider against the same directory — which is what the
    // next run of the process is.
    const second = new LocalBrowserProvider({ headless: true, profileRoot: root });
    expect(await visit(second)).toContain("KNOWN");
  }, 120_000);

  /**
   * One directory per workspace. Two users sharing cookies would be the worst
   * bug in the system, and it is the kind that looks like a feature until
   * someone notices whose account they are logged into.
   */
  it("keeps one workspace's profile away from another", async () => {
    const browser = new LocalBrowserProvider({ headless: true, profileRoot: root });
    const session = await browser.createSession(bob, { startUrl: origin });
    const text = (await browser.snapshot(bob, session.id)).text ?? "";
    await browser.shutdown();

    // Ada has visited; Bob has not, and is not carried along by her.
    expect(text).toContain("STRANGER");
  }, 120_000);

  /**
   * Without a profile root, every run is a stranger — the right behaviour for
   * a test suite, and the reason persistence is opt-in rather than the default.
   */
  it("starts fresh when no profile directory is configured", async () => {
    const once = new LocalBrowserProvider({ headless: true });
    expect(await visit(once)).toContain("STRANGER");

    const twice = new LocalBrowserProvider({ headless: true });
    expect(await visit(twice)).toContain("STRANGER");
  }, 120_000);
});
