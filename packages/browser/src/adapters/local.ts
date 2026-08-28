/**
 * Local Chromium adapter.
 *
 * The self-host default: a browser on the machine running Nell, driven through
 * the typed action DSL. No vendor account required, and it is the adapter CI
 * exercises, so the DSL contract stays honest.
 *
 * The executor is deliberately the only place that turns a typed action into a
 * real browser operation. It accepts actions, never code — there is no path from
 * a model to arbitrary script execution on a page that has had a credential
 * typed into it.
 */

import type { AccessScope } from "@nell/shared";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import {
  MODEL_DISPLAY,
  projectAction,
  type ComputerAction,
  type CoordinateSpace,
  type DisplaySize,
  type KeyName,
  type Point,
} from "../computer.js";
import type { BrowserAction, Target } from "../dsl.js";
import type {
  ActionResult,
  BrowserProvider,
  BrowserSession,
  CreateSessionOptions,
} from "../provider.js";

interface LiveSession {
  readonly session: BrowserSession;
  readonly context: BrowserContext;
  readonly page: Page;
  /**
   * Where the pointer is. Playwright exposes no getter, and a model that has
   * pressed the mouse down needs to know where it is dragging from.
   */
  cursor: Point;
}

export interface LocalBrowserOptions {
  readonly headless?: boolean;
  /**
   * The machine's real viewport. Real sites are laid out for a real screen, so
   * this is deliberately larger than the resolution screenshots are sent at.
   */
  readonly viewport?: DisplaySize;
  /** Where persistent per-merchant profiles are stored. */
  readonly profileDir?: string;
  /**
   * Resolves an opaque file reference to a path inside the session's upload
   * directory. Workers name references, never filesystem paths — otherwise
   * `upload` would be an arbitrary-file-read primitive.
   */
  readonly files?: FileResolver;
}

export interface FileResolver {
  resolve(scope: AccessScope, fileRef: string): string | undefined;
}

/** Real screen the machine runs at, when the caller does not pick one. */
const MACHINE_VIEWPORT_DEFAULT: DisplaySize = { width: 1440, height: 900 };

/**
 * Globals that exist inside the page, not in Node. Declared rather than pulled
 * in via the DOM lib, which would make every browser global look available in
 * server code where it is not.
 */
interface PageGlobals {
  requestAnimationFrame(callback: () => void): void;
}

/** Conventional pixels moved by one wheel click. */
const WHEEL_CLICK_PX = 100;

/** Our key names are Playwright's, except Space, which it spells as a literal. */
function playwrightKey(key: KeyName): string {
  return key === "Space" ? " " : key;
}

export class LocalBrowserProvider implements BrowserProvider {
  #browser: Browser | undefined;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #options: LocalBrowserOptions;
  readonly #files: FileResolver | undefined;
  #counter = 0;

  constructor(options: LocalBrowserOptions = {}) {
    this.#options = options;
    this.#files = options.files;
  }

  /**
   * How the model's screenshot relates to the real screen.
   *
   * The machine runs at a real viewport; screenshots are captured downscaled by
   * the device scale factor so the image lands at or under the resolution
   * providers recommend. Because the factor is applied at capture time by the
   * browser itself, the two sizes can never silently drift apart — which is the
   * failure that makes every click land short.
   */
  coordinateSpace(): CoordinateSpace {
    const viewport = this.#options.viewport ?? MACHINE_VIEWPORT_DEFAULT;
    const factor = Math.min(1, MODEL_DISPLAY.width / viewport.width);
    return {
      viewport,
      display: {
        width: Math.round(viewport.width * factor),
        height: Math.round(viewport.height * factor),
      },
    };
  }

  async #ensureBrowser(): Promise<Browser> {
    this.#browser ??= await chromium.launch({
      headless: this.#options.headless ?? true,
    });
    return this.#browser;
  }

  /**
   * Ownership check. A session id from another workspace is reported as missing
   * rather than forbidden, so the caller learns nothing about what exists.
   */
  #require(scope: AccessScope, sessionId: string): LiveSession {
    const live = this.#sessions.get(sessionId);
    if (!live || live.session.workspaceId !== scope.workspaceId) {
      throw new Error("Browser session not found.");
    }
    return live;
  }

  async createSession(
    scope: AccessScope,
    options: CreateSessionOptions = {}
  ): Promise<BrowserSession> {
    const browser = await this.#ensureBrowser();
    const space = this.coordinateSpace();
    const context = await browser.newContext({
      viewport: { width: space.viewport.width, height: space.viewport.height },
      deviceScaleFactor: space.display.width / space.viewport.width,
    });
    const page = await context.newPage();

    if (options.startUrl) {
      await page.goto(options.startUrl, { waitUntil: "domcontentloaded" });
    }

    this.#counter += 1;
    const session: BrowserSession = {
      id: `local-${String(this.#counter)}`,
      workspaceId: scope.workspaceId,
      profileId: options.profileId,
    };
    this.#sessions.set(session.id, { session, context, page, cursor: { x: 0, y: 0 } });
    return session;
  }

  async perform(
    scope: AccessScope,
    sessionId: string,
    actions: readonly BrowserAction[]
  ): Promise<ActionResult> {
    const { page } = this.#require(scope, sessionId);
    let extracted: Record<string, string> | undefined;
    let screenshot: string | undefined;

    for (const action of actions) {
      switch (action.action) {
        case "goto":
          await page.goto(action.url, { waitUntil: action.waitUntil });
          break;
        case "click":
          await locate(page, action.target).click();
          break;
        case "type": {
          const field = locate(page, action.target);
          if (action.clearFirst) await field.fill("");
          await field.fill(action.text);
          break;
        }
        case "select":
          await locate(page, action.target).selectOption(action.value);
          break;
        case "scroll":
          await page.mouse.wheel(0, action.direction === "down" ? action.amount : -action.amount);
          break;
        case "waitFor":
          await locate(page, action.target).waitFor({
            state: action.state,
            timeout: action.timeoutMs,
          });
          break;
        case "back":
          await page.goBack({ waitUntil: "domcontentloaded" });
          break;
        case "extract": {
          const scopeLocator = action.target ? locate(page, action.target) : undefined;
          const text = scopeLocator
            ? ((await scopeLocator.textContent()) ?? "")
            : ((await page.textContent("body")) ?? "");
          extracted = { text: text.trim().slice(0, 20_000) };
          break;
        }
        case "screenshot": {
          const buffer = await page.screenshot({ fullPage: action.fullPage });
          screenshot = buffer.toString("base64");
          break;
        }
        case "upload": {
          // Writes the FileList onto the element and fires `change`. No OS
          // dialog is ever summoned, which is why this is the reliable path —
          // a coordinate-driven native picker cannot be dismissed
          // programmatically.
          const path = this.#files?.resolve(scope, action.fileRef);
          if (!path) {
            throw new Error("No file broker configured, or unknown file reference.");
          }
          await locate(page, action.target).setInputFiles(path);
          break;
        }
        case "hover":
          await locate(page, action.target).hover();
          break;
        case "drag":
          await locate(page, action.from).dragTo(locate(page, action.to));
          break;
        case "press":
          await page.keyboard.press(action.key);
          break;
        case "click-at":
          await page.mouse.click(action.x, action.y);
          break;
        default: {
          // Exhaustiveness guard. Without this a newly declared action silently
          // no-ops and reports success — the agent would believe a file was
          // attached when nothing happened.
          const unhandled: never = action;
          throw new Error(`Unhandled browser action: ${JSON.stringify(unhandled)}`);
        }
      }
    }

    return { currentOrigin: await this.currentOrigin(scope, sessionId), extracted, screenshot };
  }

  /**
   * Drive the session the way a person does: look at the screen, act on pixels.
   *
   * Coordinates arrive in the model's screenshot space and are projected here,
   * once, before anything touches the page. A point outside that space raises
   * rather than being clamped onto the edge of the screen.
   */
  async performComputer(
    scope: AccessScope,
    sessionId: string,
    actions: readonly ComputerAction[]
  ): Promise<ActionResult> {
    const live = this.#require(scope, sessionId);
    const { page } = live;
    const space = this.coordinateSpace();
    let screenshot: string | undefined;

    for (const raw of actions) {
      const action = projectAction(space, raw);

      switch (action.action) {
        case "screenshot": {
          screenshot = (await page.screenshot()).toString("base64");
          break;
        }
        case "cursor_position":
          break;
        case "mouse_move":
          await page.mouse.move(action.coordinate.x, action.coordinate.y);
          live.cursor = action.coordinate;
          break;
        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click":
        case "triple_click": {
          const button =
            action.action === "right_click"
              ? "right"
              : action.action === "middle_click"
                ? "middle"
                : "left";
          const clickCount =
            action.action === "double_click" ? 2 : action.action === "triple_click" ? 3 : 1;

          for (const modifier of action.modifiers) await page.keyboard.down(modifier);
          try {
            await page.mouse.click(action.coordinate.x, action.coordinate.y, {
              button,
              clickCount,
            });
          } finally {
            // Released in reverse, and in a finally: a modifier left stuck down
            // silently corrupts every keystroke for the rest of the task.
            for (const modifier of [...action.modifiers].reverse()) {
              await page.keyboard.up(modifier);
            }
          }
          live.cursor = action.coordinate;
          break;
        }
        case "left_mouse_down":
          if (action.coordinate) {
            await page.mouse.move(action.coordinate.x, action.coordinate.y);
            live.cursor = action.coordinate;
          }
          await page.mouse.down();
          break;
        case "left_mouse_up":
          if (action.coordinate) {
            await page.mouse.move(action.coordinate.x, action.coordinate.y);
            live.cursor = action.coordinate;
          }
          await page.mouse.up();
          break;
        case "left_click_drag":
          await page.mouse.move(action.start_coordinate.x, action.start_coordinate.y);
          await page.mouse.down();
          await page.mouse.move(action.coordinate.x, action.coordinate.y, { steps: 12 });
          await page.mouse.up();
          live.cursor = action.coordinate;
          break;
        case "drag_path": {
          const [start, ...rest] = action.path;
          if (!start) break;
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          // Stepped between waypoints: sliders and anti-bot widgets watch the
          // movement itself, and a single jump reads as synthetic.
          for (const point of rest) await page.mouse.move(point.x, point.y, { steps: 8 });
          await page.mouse.up();
          live.cursor = rest.at(-1) ?? start;
          break;
        }
        case "scroll": {
          // Moving first is what makes this scroll the container under the
          // pointer rather than the page: map panes, modal bodies and
          // virtualised lists do not move when the document does.
          await page.mouse.move(action.coordinate.x, action.coordinate.y);
          live.cursor = action.coordinate;
          const distance = action.scroll_amount * WHEEL_CLICK_PX;
          const dx =
            action.scroll_direction === "right"
              ? distance
              : action.scroll_direction === "left"
                ? -distance
                : 0;
          const dy =
            action.scroll_direction === "down"
              ? distance
              : action.scroll_direction === "up"
                ? -distance
                : 0;
          await page.mouse.wheel(dx, dy);
          // Chromium applies wheel scrolling on the compositor, so the wheel
          // call returns before the page has actually moved. Without this the
          // very next screenshot shows the pre-scroll frame, and the model
          // concludes the page would not scroll and gives up on content that
          // was there all along. Two frames is a committed paint, not a guess.
          await page.evaluate(async () => {
            const { requestAnimationFrame: raf } = globalThis as unknown as PageGlobals;
            await new Promise<void>((resolve) => {
              raf(() => {
                raf(() => {
                  resolve();
                });
              });
            });
          });
          break;
        }
        case "type":
          await page.keyboard.type(action.text);
          break;
        case "key": {
          const [...keys] = action.keys;
          const last = keys.pop();
          if (!last) break;
          for (const modifier of keys) await page.keyboard.down(playwrightKey(modifier));
          try {
            await page.keyboard.press(playwrightKey(last));
          } finally {
            for (const modifier of keys.reverse()) await page.keyboard.up(playwrightKey(modifier));
          }
          break;
        }
        case "hold_key":
          await page.keyboard.down(playwrightKey(action.key));
          try {
            await page.waitForTimeout(action.durationMs);
          } finally {
            await page.keyboard.up(playwrightKey(action.key));
          }
          break;
        case "wait":
          await page.waitForTimeout(action.durationMs);
          break;
        default: {
          // Same guard as the targeted executor, for the same reason: a new
          // action that silently no-ops reports success, and the agent believes
          // it clicked something it never touched.
          const unhandled: never = action;
          throw new Error(`Unhandled computer action: ${JSON.stringify(unhandled)}`);
        }
      }
    }

    return {
      currentOrigin: await this.currentOrigin(scope, sessionId),
      screenshot,
      cursor: live.cursor,
    };
  }

  /**
   * The browser's real origin. The origin gate compares a vault item's allowlist
   * against THIS value, never against something the model asserted.
   */
  async currentOrigin(scope: AccessScope, sessionId: string): Promise<string> {
    const { page } = this.#require(scope, sessionId);
    try {
      return new URL(page.url()).origin;
    } catch {
      return "about:blank";
    }
  }

  async saveProfile(scope: AccessScope, sessionId: string, profileId: string): Promise<void> {
    const { context } = this.#require(scope, sessionId);
    const dir = this.#options.profileDir;
    if (!dir) return;
    await context.storageState({ path: `${dir}/${profileId}.json` });
  }

  replayUrl(_scope: AccessScope, _sessionId: string): Promise<string | undefined> {
    // Session recording is a cloud-provider capability; local runs have none.
    return Promise.resolve(undefined);
  }

  async destroy(scope: AccessScope, sessionId: string): Promise<void> {
    const live = this.#require(scope, sessionId);
    await live.context.close();
    this.#sessions.delete(sessionId);
  }

  /** Shut the shared browser down. Call once at process exit. */
  async shutdown(): Promise<void> {
    for (const [id, live] of this.#sessions) {
      await live.context.close().catch(() => undefined);
      this.#sessions.delete(id);
    }
    await this.#browser?.close();
    this.#browser = undefined;
  }
}

/** Translate a typed target into a Playwright locator. */
function locate(page: Page, target: Target): Locator {
  switch (target.by) {
    case "role": {
      const locator = page.getByRole(
        target.role as Parameters<Page["getByRole"]>[0],
        target.name === undefined ? undefined : { name: target.name }
      );
      return target.nth === undefined ? locator.first() : locator.nth(target.nth);
    }
    case "label":
      return page.getByLabel(target.text).first();
    case "placeholder":
      return page.getByPlaceholder(target.text).first();
    case "text":
      return page.getByText(target.text).first();
    case "testId":
      return page.getByTestId(target.id).first();
    case "css":
      return page.locator(target.selector).first();
  }
}
