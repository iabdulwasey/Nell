/**
 * Integration tests against a real Chromium.
 *
 * These drive an actual browser rather than a mock, so the DSL-to-Playwright
 * translation is verified rather than assumed. Pages are served from an
 * in-process HTTP server so the suite stays hermetic — no live sites, no
 * network flakiness, no rate limits.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { accessScopeForUser } from "@nell/shared";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumAvailable } from "./computer-exec.js";
import { toDisplay, type Point } from "../computer.js";
import { LocalBrowserProvider } from "./local.js";

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

const PAGE = `<!doctype html>
<html><body>
  <h1 id="title">Nell Test Page</h1>
  <label for="name">Full name</label>
  <input id="name" />
  <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
  <button id="go">Continue</button>
  <a href="/next">Next page</a>
  <div data-testid="marker">marker-value</div>
  <input id="cv" type="file" aria-label="Attach CV" />
  <div id="uploaded"></div>
  <div id="hovertarget" aria-label="Hover me">idle</div>
  <div id="hoverstate"></div>
  <input id="keyfield" aria-label="Key field" />
  <div id="keystate"></div>
  <script>
    document.getElementById('cv').addEventListener('change', (e) => {
      document.getElementById('uploaded').textContent =
        Array.from(e.target.files).map(f => f.name + ':' + f.size).join(',');
    });
    document.getElementById('hovertarget').addEventListener('mouseenter', () => {
      document.getElementById('hoverstate').textContent = 'hovered';
    });
    document.getElementById('keyfield').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('keystate').textContent = 'entered';
    });
  </script>
</body></html>`;

const NEXT = `<!doctype html><html><body><h1>Second Page</h1></body></html>`;

/**
 * A page built for pixel-driving: every target sits at an exact, known position
 * so a click can be aimed at a coordinate and verified to have landed there.
 */
const COMPUTER_PAGE = `<!doctype html>
<html><body style="margin:0">
  <div id="target" style="position:absolute;left:200px;top:200px;width:100px;height:100px;background:#ccc"></div>
  <div id="hit">none</div>
  <div id="menu">none</div>
  <input id="text" style="position:absolute;left:200px;top:400px;width:300px" />
  <div id="pane" style="position:absolute;left:600px;top:200px;width:200px;height:150px;overflow:auto">
    <div style="height:2000px">tall</div>
  </div>
  <div id="panescroll">0</div>
  <input id="slider" type="range" min="0" max="100" value="0"
         style="position:absolute;left:200px;top:600px;width:400px" />
  <div id="held">up</div>
  <div id="textvalue"></div>
  <div id="slidervalue">0</div>
  <div id="keychord">none</div>
  <input id="secret" value="hunter2-the-real-password"
         style="position:absolute;left:0px;top:750px;width:900px;height:60px;font-size:40px" />
  <script>
    document.getElementById('text').addEventListener('input', function (e) {
      document.getElementById('textvalue').textContent = e.target.value;
    });
    document.getElementById('text').addEventListener('keydown', function (e) {
      if (e.key.length === 1 && (e.ctrlKey || e.metaKey)) {
        document.getElementById('keychord').textContent =
          (e.ctrlKey ? 'ctrl+' : 'meta+') + e.key;
      }
    });
    document.getElementById('slider').addEventListener('input', function (e) {
      document.getElementById('slidervalue').textContent = e.target.value;
    });
    var t = document.getElementById('target');
    t.addEventListener('click', function (e) {
      document.getElementById('hit').textContent =
        e.clientX + ',' + e.clientY + ',' + e.detail +
        (e.shiftKey ? ',shift' : '') + (e.ctrlKey ? ',ctrl' : '');
    });
    t.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      document.getElementById('menu').textContent = 'context';
    });
    t.addEventListener('mousedown', function () {
      document.getElementById('held').textContent = 'down';
    });
    t.addEventListener('mouseup', function () {
      document.getElementById('held').textContent = 'released';
    });
    document.getElementById('pane').addEventListener('scroll', function (e) {
      document.getElementById('panescroll').textContent = String(Math.round(e.target.scrollTop));
    });
  </script>
</body></html>`;

let server: Server;
let origin: string;
let provider: LocalBrowserProvider;
let cvPath: string;

const scope = accessScopeForUser("user-browser-test");
const otherScope = accessScopeForUser("user-someone-else");

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/next") return void res.end(NEXT);
    if (req.url === "/computer") return void res.end(COMPUTER_PAGE);
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  cvPath = join(tmpdir(), `nell-cv-${String(process.pid)}.txt`);
  writeFileSync(cvPath, "Ada Lovelace — CV");
  provider = new LocalBrowserProvider({
    headless: true,
    files: { resolve: (_scope, ref) => (ref === "cv-1" ? cvPath : undefined) },
  });
}, 60_000);

afterAll(async () => {
  rmSync(cvPath, { force: true });
  await provider.shutdown();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describeBrowser("LocalBrowserProvider", () => {
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

  // These five actions were declared in the DSL but unhandled by the executor:
  // they silently no-opped and reported success. An agent would believe a CV
  // was attached when nothing had happened.
  it("actually attaches a file rather than silently no-opping", async () => {
    const provider = new LocalBrowserProvider({
      headless: true,
      files: {
        resolve: (_scope, ref) => (ref === "cv-1" ? cvPath : undefined),
      },
    });
    const session = await provider.createSession(scope, { startUrl: origin });

    await provider.perform(scope, session.id, [
      { action: "upload", target: { by: "css", selector: "#cv" }, fileRef: "cv-1" },
    ]);
    const result = await provider.perform(scope, session.id, [
      { action: "extract", target: { by: "css", selector: "#uploaded" }, fields: ["uploaded"] },
    ]);

    // The page's own change handler saw a real FileList with the right name and
    // byte count — no OS dialog was involved at any point.
    expect(result.extracted?.text).toContain("nell-cv-");
    expect(result.extracted?.text).toContain(":19");
    await provider.shutdown();
  }, 60_000);

  it("refuses an unknown file reference instead of uploading nothing", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });
    await expect(
      provider.perform(scope, session.id, [
        { action: "upload", target: { by: "css", selector: "#cv" }, fileRef: "nope" },
      ])
    ).rejects.toThrow(/file broker|unknown file/iu);
    await provider.destroy(scope, session.id);
  }, 60_000);

  it("hovers, revealing content that only appears on hover", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });
    await provider.perform(scope, session.id, [
      { action: "hover", target: { by: "css", selector: "#hovertarget" } },
    ]);
    const result = await provider.perform(scope, session.id, [
      { action: "extract", target: { by: "css", selector: "#hoverstate" }, fields: ["s"] },
    ]);
    expect(result.extracted?.text).toBe("hovered");
    await provider.destroy(scope, session.id);
  }, 60_000);

  it("presses a key, reaching flows only available from the keyboard", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });
    await provider.perform(scope, session.id, [
      { action: "click", target: { by: "css", selector: "#keyfield" } },
      { action: "press", key: "Enter" },
    ]);
    const result = await provider.perform(scope, session.id, [
      { action: "extract", target: { by: "css", selector: "#keystate" }, fields: ["s"] },
    ]);
    expect(result.extracted?.text).toBe("entered");
    await provider.destroy(scope, session.id);
  }, 60_000);

  it("clicks at a coordinate for canvas-like content", async () => {
    const session = await provider.createSession(scope, { startUrl: origin });
    // Should not throw; coordinate clicking is the escape hatch for content
    // with no accessible structure.
    await provider.perform(scope, session.id, [{ action: "click-at", x: 5, y: 5 }]);
    await provider.destroy(scope, session.id);
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

/**
 * Computer use against a real browser.
 *
 * The reason these exist rather than unit tests over the switch statement: an
 * unimplemented action returns success and no-ops, and the agent then believes
 * it clicked something it never touched. Only a real page can prove otherwise,
 * so every action asserts on an observable change the page itself recorded.
 */
describeBrowser("computer use", () => {
  /** A viewport point expressed the way a model looking at a screenshot would. */
  function asModelSees(point: Point): Point {
    return toDisplay(provider.coordinateSpace(), point);
  }

  async function computerSession(): Promise<string> {
    const session = await provider.createSession(scope, { startUrl: `${origin}/computer` });
    return session.id;
  }

  async function readText(sessionId: string, id: string): Promise<string> {
    const result = await provider.perform(scope, sessionId, [
      { action: "extract", target: { by: "css", selector: `#${id}` }, fields: ["text"] },
    ]);
    return result.extracted?.["text"] ?? "";
  }

  // The headline claim: a click aimed at a coordinate lands at that coordinate.
  it("clicks where the model aimed, after scaling", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [
      { action: "left_click", coordinate: asModelSees({ x: 250, y: 250 }), modifiers: [] },
    ]);

    // Within a pixel: the model's space is coarser than the viewport, so the
    // round-trip cannot be exact — but it must land inside the 100x100 target.
    const [x, y, detail] = (await readText(id, "hit")).split(",");
    expect(Number(x)).toBeGreaterThanOrEqual(200);
    expect(Number(x)).toBeLessThan(300);
    expect(Number(y)).toBeGreaterThanOrEqual(200);
    expect(Number(y)).toBeLessThan(300);
    expect(detail).toBe("1");
    await provider.destroy(scope, id);
  }, 60_000);

  it("holds modifiers during a click and releases them after", async () => {
    const id = await computerSession();
    const at = asModelSees({ x: 250, y: 250 });
    await provider.performComputer(scope, id, [
      { action: "left_click", coordinate: at, modifiers: ["Shift"] },
    ]);
    expect(await readText(id, "hit")).toContain("shift");

    // A modifier left stuck down would silently corrupt every later keystroke.
    await provider.performComputer(scope, id, [
      { action: "left_click", coordinate: at, modifiers: [] },
    ]);
    expect(await readText(id, "hit")).not.toContain("shift");
    await provider.destroy(scope, id);
  }, 60_000);

  it("distinguishes double and triple clicks", async () => {
    const id = await computerSession();
    const at = asModelSees({ x: 250, y: 250 });

    await provider.performComputer(scope, id, [
      { action: "double_click", coordinate: at, modifiers: [] },
    ]);
    expect((await readText(id, "hit")).split(",")[2]).toBe("2");

    await provider.performComputer(scope, id, [
      { action: "triple_click", coordinate: at, modifiers: [] },
    ]);
    expect((await readText(id, "hit")).split(",")[2]).toBe("3");
    await provider.destroy(scope, id);
  }, 60_000);

  it("opens a context menu with a right click", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [
      { action: "right_click", coordinate: asModelSees({ x: 250, y: 250 }), modifiers: [] },
    ]);
    expect(await readText(id, "menu")).toBe("context");
    await provider.destroy(scope, id);
  }, 60_000);

  // The primitive a compound drag cannot express: a press that stays down.
  it("holds the button down across separate actions", async () => {
    const id = await computerSession();
    const at = asModelSees({ x: 250, y: 250 });

    await provider.performComputer(scope, id, [{ action: "left_mouse_down", coordinate: at }]);
    expect(await readText(id, "held")).toBe("down");

    await provider.performComputer(scope, id, [{ action: "left_mouse_up", coordinate: at }]);
    expect(await readText(id, "held")).toBe("released");
    await provider.destroy(scope, id);
  }, 60_000);

  it("drags a slider to a new value", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [
      {
        action: "left_click_drag",
        start_coordinate: asModelSees({ x: 210, y: 610 }),
        coordinate: asModelSees({ x: 500, y: 610 }),
      },
    ]);

    expect(Number(await readText(id, "slidervalue"))).toBeGreaterThan(0);
    await provider.destroy(scope, id);
  }, 60_000);

  it("follows a multi-point drag path", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [
      {
        action: "drag_path",
        path: [
          asModelSees({ x: 210, y: 610 }),
          asModelSees({ x: 300, y: 605 }),
          asModelSees({ x: 450, y: 610 }),
        ],
      },
    ]);
    expect(Number(await readText(id, "slidervalue"))).toBeGreaterThan(0);
    await provider.destroy(scope, id);
  }, 60_000);

  // The reason scroll takes a coordinate: an inner pane does not move when the
  // document does.
  it("scrolls the container under the pointer, not the page", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [
      {
        action: "scroll",
        coordinate: asModelSees({ x: 700, y: 270 }),
        scroll_direction: "down",
        scroll_amount: 3,
      },
    ]);
    expect(Number(await readText(id, "panescroll"))).toBeGreaterThan(0);
    await provider.destroy(scope, id);
  }, 60_000);

  it("types into whatever has focus", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [
      { action: "left_click", coordinate: asModelSees({ x: 300, y: 410 }), modifiers: [] },
      { action: "type", text: "Ada Lovelace" },
    ]);

    expect(await readText(id, "textvalue")).toBe("Ada Lovelace");
    await provider.destroy(scope, id);
  }, 60_000);

  it("presses a key chord", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [
      { action: "left_click", coordinate: asModelSees({ x: 300, y: 410 }), modifiers: [] },
      { action: "key", keys: ["Control", "a"] },
    ]);
    // The page records the modifier alongside the key, so a chord that arrived
    // as a bare keypress — the failure mode if the modifier were never held —
    // records nothing.
    expect(await readText(id, "keychord")).toBe("ctrl+a");
    await provider.destroy(scope, id);
  }, 60_000);

  it("returns a screenshot at the resolution it declares", async () => {
    const id = await computerSession();
    const result = await provider.performComputer(scope, id, [{ action: "screenshot" }]);
    expect(result.screenshot).toBeTruthy();

    // A model told the screen is one size while shown another aims every click
    // at the wrong place, so the declared size must match the captured image.
    const png = Buffer.from(result.screenshot ?? "", "base64");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const space = provider.coordinateSpace();
    expect(width).toBe(space.display.width);
    expect(height).toBe(space.display.height);
    await provider.destroy(scope, id);
  }, 60_000);

  it("reports where the pointer ended up", async () => {
    const id = await computerSession();
    const result = await provider.performComputer(scope, id, [
      { action: "mouse_move", coordinate: asModelSees({ x: 250, y: 250 }) },
    ]);
    expect(result.cursor?.x).toBeGreaterThan(240);
    expect(result.cursor?.y).toBeGreaterThan(240);
    await provider.destroy(scope, id);
  }, 60_000);

  it("waits without failing", async () => {
    const id = await computerSession();
    await provider.performComputer(scope, id, [{ action: "wait", durationMs: 50 }]);
    expect(await provider.currentOrigin(scope, id)).toBe(origin);
    await provider.destroy(scope, id);
  }, 60_000);

  // Clamping would turn "the model is looking at a different screen" into a
  // plausible-looking click on the edge of the page.
  it("refuses a coordinate outside the screen it showed the model", async () => {
    const id = await computerSession();
    await expect(
      provider.performComputer(scope, id, [
        { action: "left_click", coordinate: { x: 9000, y: 10 }, modifiers: [] },
      ])
    ).rejects.toThrow(/outside/iu);
    await provider.destroy(scope, id);
  }, 60_000);

  // Perception mode must never be a way around ownership.
  it("refuses a session belonging to another workspace", async () => {
    const id = await computerSession();
    await expect(
      provider.performComputer(otherScope, id, [{ action: "screenshot" }])
    ).rejects.toThrow(/not found/iu);
    await provider.destroy(scope, id);
  }, 60_000);
});

/**
 * Masking is what stands between a tainted session and a plaintext password in
 * the model's context window. Asserting the option was passed proves nothing --
 * only the encoded image does.
 */
describeBrowser("secret masking", () => {
  it("paints over a masked field before the PNG is encoded", async () => {
    const session = await provider.createSession(scope, { startUrl: `${origin}/computer` });

    const clear = await provider.performComputer(scope, session.id, [{ action: "screenshot" }]);
    const masked = await provider.performComputer(scope, session.id, [{ action: "screenshot" }], {
      maskSelectors: ["#secret"],
    });

    expect(clear.screenshot).toBeTruthy();
    expect(masked.screenshot).toBeTruthy();
    // Same page, same moment, different pixels: the mask is real and not an
    // option that was accepted and ignored.
    expect(masked.screenshot).not.toBe(clear.screenshot);

    await provider.destroy(scope, session.id);
  }, 60_000);

  it("masks on the targeted screenshot path too", async () => {
    const session = await provider.createSession(scope, { startUrl: `${origin}/computer` });

    const clear = await provider.perform(scope, session.id, [
      { action: "screenshot", fullPage: false },
    ]);
    const masked = await provider.perform(
      scope,
      session.id,
      [{ action: "screenshot", fullPage: false }],
      { maskSelectors: ["#secret"] }
    );

    expect(masked.screenshot).not.toBe(clear.screenshot);
    await provider.destroy(scope, session.id);
  }, 60_000);

  // A selector that matches nothing must not throw -- taint carries selectors
  // from a page the session may since have navigated away from.
  it("tolerates a mask selector that matches nothing", async () => {
    const session = await provider.createSession(scope, { startUrl: `${origin}/computer` });
    const result = await provider.performComputer(scope, session.id, [{ action: "screenshot" }], {
      maskSelectors: ["#not-on-this-page"],
    });
    expect(result.screenshot).toBeTruthy();
    await provider.destroy(scope, session.id);
  }, 60_000);
});
