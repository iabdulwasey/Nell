/**
 * The persistent machine, against a real browser.
 *
 * The claim being tested is the one the architecture rests on: state survives.
 * A mock cannot show that — only a real Chromium profile written to a real disk,
 * closed, and reopened.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { accessScopeForUser } from "@nell/shared";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumAvailable } from "./computer-exec.js";
import { MachineRegistry } from "../machine.js";
import { LocalMachineHost } from "./local-machine.js";

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

/**
 * A page that reports what the browser remembers by navigating to it.
 *
 * Reading the answer out of the URL rather than out of the DOM keeps the test
 * honest: it uses only what the machine port actually exposes, so it cannot pass
 * by reaching past the interface the product uses.
 */
function pageFor(url: string): string {
  if (url.startsWith("/set/")) {
    const value = url.slice("/set/".length);
    return `<!doctype html><html><body><script>
      localStorage.setItem('nell-test', ${JSON.stringify(value)});
      location.replace('/');
    </script></body></html>`;
  }
  if (url.startsWith("/seen/")) {
    return `<!doctype html><html><body><h1>remembered</h1></body></html>`;
  }
  return `<!doctype html><html><body><script>
    location.replace('/seen/' + (localStorage.getItem('nell-test') || 'nothing'));
  </script></body></html>`;
}

let server: Server;
let origin: string;
let root: string;
let host: LocalMachineHost;

const scope = accessScopeForUser("user-machine-test");

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pageFor(req.url ?? "/"));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  root = mkdtempSync(join(tmpdir(), "nell-machines-"));
  host = new LocalMachineHost({ root, headless: true });
}, 60_000);

afterAll(async () => {
  await host.shutdown();
  rmSync(root, { recursive: true, force: true });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describeBrowser("LocalMachineHost", () => {
  it("provisions a machine with its own profile on disk", async () => {
    const machine = await host.provision("ws-1", { scratch: false });
    expect(machine.state).toBe("running");
    expect(existsSync(join(root, machine.id))).toBe(true);
    await host.destroy(machine.id);
  }, 60_000);

  // The whole reason the machine is persistent. If this fails, every task
  // re-authenticates and the vault is touched on every run.
  it("remembers site state across a standby and a resume", async () => {
    const machine = await host.provision("ws-2", { scratch: false });

    await remember(machine.id, "seen-before");

    await host.standby(machine.id);
    await host.resume(machine.id);

    expect(await recall(machine.id)).toBe("seen-before");
    await host.destroy(machine.id);
  }, 90_000);

  // Age is accrued device trust; losing it to a restart silently resets the one
  // property only time can rebuild.
  it("keeps the machine's age across a standby and a resume", async () => {
    const machine = await host.provision("ws-3", { scratch: false });
    await host.standby(machine.id);
    const woken = await host.resume(machine.id);

    expect(woken.createdAt).toBe(machine.createdAt);
    expect(woken.id).toBe(machine.id);
    await host.destroy(machine.id);
  }, 60_000);

  it("keeps two workspaces' machines entirely separate", async () => {
    const a = await host.provision("ws-a", { scratch: false });
    const b = await host.provision("ws-b", { scratch: false });

    await remember(a.id, "belongs-to-a");

    expect(await recall(b.id)).toBe("nothing");
    expect(await recall(a.id)).toBe("belongs-to-a");

    await host.destroy(a.id);
    await host.destroy(b.id);
  }, 90_000);

  it("wakes on demand when acted on while suspended", async () => {
    const machine = await host.provision("ws-4", { scratch: false });
    await host.standby(machine.id);

    const outcome = await host.actBatch(machine.id, [{ action: "wait", durationMs: 1 }]);
    expect(outcome.currentOrigin).toBeTruthy();
    await host.destroy(machine.id);
  }, 60_000);

  // A machine driven only by pixels has no address bar to type a URL into, so
  // navigation must be an operation the host provides.
  it("navigates, and reports which page it landed on", async () => {
    const machine = await host.provision("ws-nav", { scratch: false });
    const outcome = await host.navigate(machine.id, `${origin}/seen/direct`);

    expect(outcome.currentOrigin).toBe(origin);
    expect(outcome.currentUrl).toBe(`${origin}/seen/direct`);
    await host.destroy(machine.id);
  }, 60_000);

  // Same reasoning as the targeted DSL: these are all valid URLs, and all three
  // turn a navigation into code execution or local-file access.
  it("refuses a navigation that is not http(s)", async () => {
    const machine = await host.provision("ws-nav2", { scratch: false });
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      await expect(host.navigate(machine.id, url)).rejects.toThrow(/http/iu);
    }
    await host.destroy(machine.id);
  }, 60_000);

  it("takes a screenshot of the machine's screen", async () => {
    const machine = await host.provision("ws-5", { scratch: false });
    const outcome = await host.actBatch(machine.id, [{ action: "screenshot" }]);
    expect(outcome.screenshot).toBeTruthy();
    await host.destroy(machine.id);
  }, 60_000);

  // Destruction is irreversible and must actually remove the disk, or "deleted"
  // is a lie told to a user who asked to be forgotten.
  it("erases the profile when destroyed", async () => {
    const machine = await host.provision("ws-6", { scratch: false });
    const dir = join(root, machine.id);
    expect(existsSync(dir)).toBe(true);

    await host.destroy(machine.id);
    expect(existsSync(dir)).toBe(false);
  }, 60_000);

  it("reports a machine that no longer exists as missing", async () => {
    await expect(host.resume("local-machine-nope")).rejects.toThrow(/no machine/iu);
  }, 60_000);

  // The registry is the thing product code uses; this proves it drives a real
  // host, not only the fake in its unit tests.
  it("drives a real host through the registry", async () => {
    const registry = new MachineRegistry({ host });

    const first = await registry.acquire(scope);
    await registry.release(first.id);
    const second = await registry.acquire(scope);

    expect(second.id).toBe(first.id);
    expect(second.tasksServed).toBe(2);

    const receipt = await registry.destroy(scope, "test cleanup");
    expect(receipt?.machineId).toBe(first.id);
    expect(existsSync(join(root, first.id))).toBe(false);
  }, 90_000);
});

/** Tell the machine to remember something, using only the machine port. */
async function remember(machineId: string, value: string): Promise<void> {
  await host.navigate(machineId, `${origin}/set/${value}`);
  await settle(machineId);
}

/** Ask the machine what it remembers; the answer arrives in the URL. */
async function recall(machineId: string): Promise<string> {
  const outcome = await host.navigate(machineId, origin);
  const settled = await settle(machineId);
  const url = settled.currentUrl || outcome.currentUrl;
  return url.slice(url.lastIndexOf("/") + 1);
}

/** Let the page's client-side redirect land. */
async function settle(machineId: string) {
  return host.actBatch(machineId, [{ action: "wait", durationMs: 300 }]);
}
