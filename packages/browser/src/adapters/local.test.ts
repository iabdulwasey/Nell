/**
 * Integration tests against a real Chromium.
 *
 * These drive an actual browser rather than a mock, so the DSL-to-Playwright
 * translation is verified rather than assumed. Pages are served from an
 * in-process HTTP server so the suite stays hermetic — no live sites, no
 * network flakiness, no rate limits.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { accessScopeForUser } from "@nell/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalBrowserProvider } from "./local.js";

const PAGE = `<!doctype html>
<html><body>
  <h1 id="title">Nell Test Page</h1>
  <label for="name">Full name</label>
  <input id="name" />
  <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
  <button id="go">Continue</button>
  <a href="/next">Next page</a>
  <div data-testid="marker">marker-value</div>
</body></html>`;

const NEXT = `<!doctype html><html><body><h1>Second Page</h1></body></html>`;

let server: Server;
let origin: string;
let provider: LocalBrowserProvider;

const scope = accessScopeForUser("user-browser-test");
const otherScope = accessScopeForUser("user-someone-else");

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/next" ? NEXT : PAGE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  provider = new LocalBrowserProvider({ headless: true });
}, 60_000);

afterAll(async () => {
  await provider.shutdown();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("LocalBrowserProvider", () => {
  it("creates a session and reports the real origin", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });
    expect(session.workspaceId).toBe(scope.workspaceId);
    expect(await provider.currentOrigin(scope, session.id)).toBe(origin);
    await provider.destroy(scope, session.id);
  }, 60_000);

  it("executes a batch of typed actions against a real page", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });

    const result = await provider.perform(scope, session.id, [
      { action: "type", target: { by: "label", text: "Full name" }, text: "Ada", clearFirst: true },
      { action: "select", target: { by: "css", selector: "#size" }, value: "l" },
      {
        action: "waitFor",
        target: { by: "testId", id: "marker" },
        state: "visible",
        timeoutMs: 5000,
      },
      { action: "extract", target: { by: "css", selector: "#title" }, fields: ["title"] },
    ]);

    expect(result.extracted?.text).toBe("Nell Test Page");
    expect(result.currentOrigin).toBe(origin);
    await provider.destroy(scope, session.id);
  }, 60_000);

  it("navigates, follows links, and goes back", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });

    await provider.perform(scope, session.id, [
      { action: "click", target: { by: "text", text: "Next page" } },
      {
        action: "waitFor",
        target: { by: "role", role: "heading" },
        state: "visible",
        timeoutMs: 5000,
      },
    ]);
    const onSecond = await provider.perform(scope, session.id, [
      { action: "extract", target: { by: "role", role: "heading" }, fields: ["heading"] },
    ]);
    expect(onSecond.extracted?.text).toBe("Second Page");

    const afterBack = await provider.perform(scope, session.id, [
      { action: "back" },
      { action: "extract", target: { by: "css", selector: "#title" }, fields: ["title"] },
    ]);
    expect(afterBack.extracted?.text).toBe("Nell Test Page");
    await provider.destroy(scope, session.id);
  }, 60_000);

  it("captures a screenshot as base64 PNG", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });
    const result = await provider.perform(scope, session.id, [
      { action: "screenshot", fullPage: false },
    ]);
    expect(result.screenshot).toBeDefined();
    // PNG magic number, base64-encoded, starts "iVBORw0KGgo".
    expect(result.screenshot?.startsWith("iVBORw0KGgo")).toBe(true);
    await provider.destroy(scope, session.id);
  }, 60_000);

  // Tenant isolation at the adapter boundary, not just in the database.
  it("refuses to touch a session belonging to another workspace", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });

    await expect(provider.currentOrigin(otherScope, session.id)).rejects.toThrow(/not found/iu);
    await expect(provider.perform(otherScope, session.id, [{ action: "back" }])).rejects.toThrow(
      /not found/iu
    );
    await expect(provider.destroy(otherScope, session.id)).rejects.toThrow(/not found/iu);

    // The rightful owner is unaffected.
    expect(await provider.currentOrigin(scope, session.id)).toBe(origin);
    await provider.destroy(scope, session.id);
  }, 60_000);

  it("reports an unknown session as not found", async () => {
    await expect(provider.currentOrigin(scope, "local-does-not-exist")).rejects.toThrow(
      /not found/iu
    );
  }, 60_000);

  it("isolates sessions from each other", async () => {
    const a = await provider.createSession(scope, { startUrl: origin });
    const b = await provider.createSession(scope, { startUrl: `${origin}/next` });

    await provider.perform(scope, a.id, [
      {
        action: "type",
        target: { by: "label", text: "Full name" },
        text: "only-in-a",
        clearFirst: true,
      },
    ]);

    // Session b never saw that input; it is on a different page entirely.
    const bText = await provider.perform(scope, b.id, [{ action: "extract", fields: ["body"] }]);
    expect(bText.extracted?.text).not.toContain("only-in-a");

    await provider.destroy(scope, a.id);
    await provider.destroy(scope, b.id);
  }, 60_000);
});
