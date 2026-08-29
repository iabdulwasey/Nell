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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AccessScope } from "@nell/shared";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import type { PageSnapshot } from "../perception.js";
import {
  MODEL_DISPLAY,
  toViewport,
  type ComputerAction,
  type CoordinateSpace,
  type DisplaySize,
  type Point,
} from "../computer.js";
import { runComputerActions, screenshotOf, type CaptureOptions } from "./computer-exec.js";
import { isCurrentRef, refSelector, snapshotPage } from "./snapshot.js";
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
  /** Replaced by `reset` between tasks; the context, and so the cookies, is not. */
  page: Page;
  /** Bumped on every snapshot; refs from earlier versions are stale. */
  snapshotVersion: number;
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
  /** Where a portable snapshot of cookies is written, when one is asked for. */
  readonly profileDir?: string;
  /**
   * Where each workspace's browser profile lives on disk.
   *
   * Set it and the browser survives a restart: cookies, storage, and the
   * profile a site has come to recognise. Leave it unset and every run starts
   * as a stranger, which is right for tests and wrong for a real user — the
   * whole reason a persistent machine is the architecture is that logins
   * accumulate, and a login that does not outlive the process accumulates
   * nothing.
   *
   * One directory per workspace, because Chromium locks a profile to a single
   * running instance and because two users sharing cookies would be the worst
   * bug in the system.
   */
  readonly profileRoot?: string;
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

export class LocalBrowserProvider implements BrowserProvider {
  #browser: Browser | undefined;
  readonly #sessions = new Map<string, LiveSession>();
  /** One persistent browser per workspace, keyed so a relaunch can close the last. */
  readonly #profiles = new Map<string, BrowserContext>();
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

  async #createPersistent(
    scope: AccessScope,
    root: string,
    options: CreateSessionOptions
  ): Promise<BrowserSession> {
    const context = await this.#persistentContext(scope.workspaceId, root);
    context.setDefaultTimeout(12_000);
    context.setDefaultNavigationTimeout(30_000);

    // A persistent context opens with a page already; reusing it avoids a blank
    // second tab sitting behind everything for the life of the profile.
    const page = context.pages()[0] ?? (await context.newPage());
    await page.addInitScript(
      `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`
    );

    if (options.startUrl) {
      await page.goto(options.startUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    this.#counter += 1;
    const session: BrowserSession = {
      id: `local-${String(this.#counter)}`,
      workspaceId: scope.workspaceId,
      profileId: options.profileId,
    };
    this.#sessions.set(session.id, {
      session,
      context,
      page,
      cursor: { x: 0, y: 0 },
      snapshotVersion: 0,
    });
    return session;
  }

  async #ensureBrowser(): Promise<Browser> {
    /**
     * Ordinary hygiene, not evasion.
     *
     * A bare launch is the most conspicuous configuration available:
     * `navigator.webdriver` is true and the user agent says `HeadlessChrome`,
     * both of which any site can read in one line of JavaScript. Watched live,
     * four consecutive sites refused on exactly that basis and the task ended
     * with nothing.
     *
     * The flag removes the `webdriver` property; the user agent is corrected
     * where contexts are created. Neither claims to be anything the browser is
     * not — it *is* Chromium, at the version it reports — they stop it
     * announcing that a program is holding the mouse.
     *
     * This will not beat serious bot detection, which fingerprints TLS and
     * canvas and timing, and saying so matters: the honest answers to that are
     * the user's own browser over the companion, or a vendor with residential
     * egress. Anything here is the easy half.
     *
     * Site isolation is deliberately left alone. Turning it off is the usual
     * next suggestion and it weakens a real security boundary in a browser that
     * handles the user's logged-in sessions.
     */
    this.#browser ??= await chromium.launch({
      headless: this.#options.headless ?? true,
      args: ["--disable-blink-features=AutomationControlled"],
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

  /**
   * A workspace's own browser, kept on disk.
   *
   * `launchPersistentContext` rather than a context inside a shared browser:
   * that is what makes the profile a real one — the same cookies, the same
   * storage, the same accumulated history the next time the process starts.
   * A `storageState` snapshot would carry the cookies and none of the rest, and
   * the rest is what a site is looking at when it decides whether this is a
   * browser it has seen before.
   *
   * Any context already open for this workspace is closed first. Chromium locks
   * a profile directory to one running instance, so a second launch against the
   * same directory fails — and the case that reaches here is a session the pool
   * found dead, which is exactly when a stale lock would still be held.
   */
  async #persistentContext(workspaceId: string, root: string): Promise<BrowserContext> {
    const existing = this.#profiles.get(workspaceId);
    if (existing) {
      await existing.close().catch(() => undefined);
      this.#profiles.delete(workspaceId);
    }

    const space = this.coordinateSpace();
    const dir = join(root, workspaceId.replaceAll(/[^\w.-]/gu, "_"));
    mkdirSync(dir, { recursive: true });

    const context = await chromium.launchPersistentContext(dir, {
      headless: this.#options.headless ?? true,
      args: ["--disable-blink-features=AutomationControlled"],
      viewport: { width: space.viewport.width, height: space.viewport.height },
      deviceScaleFactor: space.display.width / space.viewport.width,
      locale: "en-US",
    });

    this.#profiles.set(workspaceId, context);
    return context;
  }

  async createSession(
    scope: AccessScope,
    options: CreateSessionOptions = {}
  ): Promise<BrowserSession> {
    const root = this.#options.profileRoot;
    if (root) return this.#createPersistent(scope, root, options);

    const browser = await this.#ensureBrowser();
    const space = this.coordinateSpace();
    const context = await browser.newContext({
      viewport: { width: space.viewport.width, height: space.viewport.height },
      deviceScaleFactor: space.display.width / space.viewport.width,
      // Derived from the running browser rather than invented: a user agent
      // claiming a version the browser does not have is a stronger signal than
      // the one it replaces, since everything else about the page still reports
      // the truth.
      userAgent: presentableUserAgent(browser.version()),
      locale: "en-US",
    });
    /**
     * Twelve seconds, not thirty.
     *
     * Playwright's default means a click on something that is not there costs
     * half a minute of silence before anything can react — and the loop's
     * recovery is to look again and try another way, which is worth reaching
     * quickly. Three attempts now cost less than one used to.
     *
     * Navigation keeps the longer budget: a slow site is still loading, and
     * abandoning it early turns a working page into a failure.
     */
    context.setDefaultTimeout(12_000);
    context.setDefaultNavigationTimeout(30_000);

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
    this.#sessions.set(session.id, {
      session,
      context,
      page,
      cursor: { x: 0, y: 0 },
      snapshotVersion: 0,
    });
    return session;
  }

  /**
   * A new page in the same context.
   *
   * The context is where cookies, storage and logins live, so replacing only
   * the page keeps every one of them while giving the next task a clean start.
   * The snapshot version is deliberately *not* reset: refs must never repeat
   * across a session, or a ref held from before this call could resolve against
   * an element it never named.
   */
  async reset(scope: AccessScope, sessionId: string): Promise<void> {
    const live = this.#require(scope, sessionId);
    const page = await live.context.newPage();
    await live.page.close().catch(() => undefined);
    live.page = page;
    live.cursor = { x: 0, y: 0 };
  }

  async perform(
    scope: AccessScope,
    sessionId: string,
    actions: readonly BrowserAction[],
    options: CaptureOptions = {}
  ): Promise<ActionResult> {
    const live = this.#require(scope, sessionId);
    const { page } = live;
    let extracted: Record<string, string> | undefined;
    let screenshot: string | undefined;

    for (const action of actions) {
      switch (action.action) {
        case "goto":
          await page.goto(action.url, { waitUntil: action.waitUntil });
          break;
        case "click":
          await locate(page, action.target, live.snapshotVersion).click();
          break;
        case "type": {
          const field = locate(page, action.target, live.snapshotVersion);
          if (action.clearFirst) await field.fill("");
          await field.fill(action.text);
          break;
        }
        case "select":
          await locate(page, action.target, live.snapshotVersion).selectOption(action.value);
          break;
        case "scroll":
          await page.mouse.wheel(0, action.direction === "down" ? action.amount : -action.amount);
          break;
        case "waitFor":
          await locate(page, action.target, live.snapshotVersion).waitFor({
            state: action.state,
            timeout: action.timeoutMs,
          });
          break;
        case "back":
          await page.goBack({ waitUntil: "domcontentloaded" });
          break;
        case "extract": {
          const scopeLocator = action.target
            ? locate(page, action.target, live.snapshotVersion)
            : undefined;
          const text = scopeLocator
            ? ((await scopeLocator.textContent()) ?? "")
            : ((await page.textContent("body")) ?? "");
          extracted = { text: text.trim().slice(0, 20_000) };
          break;
        }
        case "screenshot":
          screenshot = await screenshotOf(page, { ...options, fullPage: action.fullPage });
          break;
        case "upload": {
          // Writes the FileList onto the element and fires `change`. No OS
          // dialog is ever summoned, which is why this is the reliable path —
          // a coordinate-driven native picker cannot be dismissed
          // programmatically.
          const path = this.#files?.resolve(scope, action.fileRef);
          if (!path) {
            throw new Error("No file broker configured, or unknown file reference.");
          }
          await locate(page, action.target, live.snapshotVersion).setInputFiles(path);
          break;
        }
        case "hover":
          await locate(page, action.target, live.snapshotVersion).hover();
          break;
        case "drag":
          await locate(page, action.from, live.snapshotVersion).dragTo(
            locate(page, action.to, live.snapshotVersion)
          );
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
   * Shares one implementation with the persistent-machine host, so the two
   * cannot drift apart on what an action means or on whether a capture is
   * masked.
   */
  async performComputer(
    scope: AccessScope,
    sessionId: string,
    actions: readonly ComputerAction[],
    options: CaptureOptions = {}
  ): Promise<ActionResult> {
    const live = this.#require(scope, sessionId);
    const outcome = await runComputerActions(
      live.page,
      actions,
      this.coordinateSpace(),
      live.cursor,
      options
    );
    live.cursor = outcome.cursor;

    return {
      currentOrigin: await this.currentOrigin(scope, sessionId),
      screenshot: outcome.screenshot,
      cursor: outcome.cursor,
    };
  }

  /**
   * The browser's real origin. The origin gate compares a vault item's allowlist
   * against THIS value, never against something the model asserted.
   */
  /**
   * Look at the page.
   *
   * Bumps the version first, which clears the previous stamps — so every ref
   * handed out before this call stops resolving. That is the point: a plan built
   * from an old look cannot half-apply to a page that has since changed.
   */
  async snapshot(scope: AccessScope, sessionId: string, maxNodes?: number): Promise<PageSnapshot> {
    const live = this.#require(scope, sessionId);
    live.snapshotVersion += 1;
    return snapshotPage(live.page, live.snapshotVersion, maxNodes);
  }

  /**
   * What a click would hit, in words.
   *
   * The spend gate reads this to decide whether a click commits money, so it
   * runs on the click path and has to be cheap and total: it never throws, and
   * an element it cannot describe comes back as an empty string, which the gate
   * treats as not-a-purchase.
   *
   * Accessible name first, then visible text. A payment button is usually a
   * `<button>` with text, but the ones that are an icon plus an `aria-label`
   * are exactly the ones worth catching.
   */
  async labelOf(
    scope: AccessScope,
    sessionId: string,
    target:
      | { readonly kind: "target"; readonly target: Target }
      | { readonly kind: "point"; readonly x: number; readonly y: number }
  ): Promise<string> {
    const live = this.#require(scope, sessionId);

    try {
      if (target.kind === "target") {
        const locator = locate(live.page, target.target, live.snapshotVersion);
        const aria = await locator.getAttribute("aria-label", { timeout: 2000 });
        if (aria?.trim()) return aria;
        const value = await locator.getAttribute("value", { timeout: 2000 });
        const text = (await locator.textContent({ timeout: 2000 })) ?? "";
        return text.trim() || (value ?? "");
      }

      /**
       * A pixel click needs the element under the point.
       *
       * Coordinates arrive in the model's display space and the page is in
       * viewport space, so the same projection the click will use has to be
       * applied here — reading the label of a different element than the one
       * about to be pressed would be worse than reading none.
       *
       * `closest` walks up from whatever fragment is on top: a click usually
       * lands on the span inside the button, and the words are on the button.
       */
      const point = toViewport(this.coordinateSpace(), { x: target.x, y: target.y });
      const label = await live.page.evaluate(
        `(() => {
          const at = document.elementFromPoint(${String(point.x)}, ${String(point.y)});
          if (!at) return "";
          const el = at.closest('button,a,[role="button"],input[type="submit"]') || at;
          return (el.getAttribute('aria-label') || el.textContent || el.value || '').trim();
        })()`
      );
      return typeof label === "string" ? label : "";
    } catch {
      // Never throws: the gate's contract is that unreadable is not unusable.
      return "";
    }
  }

  async currentOrigin(scope: AccessScope, sessionId: string): Promise<string> {
    const { page } = this.#require(scope, sessionId);
    try {
      return new URL(page.url()).origin;
    } catch {
      return "about:blank";
    }
  }

  /**
   * A portable snapshot of cookies and storage.
   *
   * **Not how the profile persists**, and worth saying because it looks like it
   * is: this writes a file that nothing in the system reads back, and did so
   * long before `profileRoot` existed — a save with no load, which is a feature
   * that cannot work. Persistence comes from the profile directory, which
   * Chromium maintains itself.
   *
   * Kept because a portable snapshot is genuinely useful for the thing it is
   * named after: moving a logged-in session to another machine, or handing one
   * to a cloud browser that cannot mount a local directory.
   */
  async saveProfile(scope: AccessScope, sessionId: string, profileId: string): Promise<void> {
    const { context } = this.#require(scope, sessionId);
    const dir = this.#options.profileDir;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    await context.storageState({ path: join(dir, `${profileId}.json`) });
  }

  replayUrl(_scope: AccessScope, _sessionId: string): Promise<string | undefined> {
    // Session recording is a cloud-provider capability; local runs have none.
    return Promise.resolve(undefined);
  }

  async destroy(scope: AccessScope, sessionId: string): Promise<void> {
    const live = this.#require(scope, sessionId);
    await live.context.close();
    this.#sessions.delete(sessionId);
    // A persistent context is the browser, so closing it releases the profile
    // lock — and leaving a stale entry here would make the next launch close
    // something already gone.
    if (this.#profiles.get(scope.workspaceId) === live.context) {
      this.#profiles.delete(scope.workspaceId);
    }
  }

  /** Shut everything down. Call once at process exit. */
  async shutdown(): Promise<void> {
    for (const [id, live] of this.#sessions) {
      await live.context.close().catch(() => undefined);
      this.#sessions.delete(id);
    }
    // Persistent contexts are browsers in their own right and are not closed by
    // closing the shared one — left open, they keep a lock on the profile that
    // the next run needs.
    for (const [workspaceId, context] of this.#profiles) {
      await context.close().catch(() => undefined);
      this.#profiles.delete(workspaceId);
    }
    await this.#browser?.close();
    this.#browser = undefined;
  }
}

/** Translate a typed target into a Playwright locator. */
/**
 * Turn a target into a locator.
 *
 * Takes the session's current snapshot version so a stale ref can be rejected
 * here, with a sentence, rather than becoming a thirty-second Playwright timeout
 * that is technically a failure and practically a mystery.
 */
function locate(page: Page, target: Target, snapshotVersion: number): Locator {
  switch (target.by) {
    case "ref": {
      if (!isCurrentRef(target.ref, snapshotVersion)) {
        throw new Error(
          `${target.ref} is from an earlier look at this page. Take a new snapshot — ` +
            `the element it named may have moved or gone.`
        );
      }
      return page.locator(refSelector(target.ref)).first();
    }
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

/**
 * The browser's own user agent, minus the word that gives it away.
 *
 * Playwright reports `HeadlessChrome/141.0.0.0` when headless, which is both
 * accurate and the single easiest thing for a site to key on. The version is
 * taken from the live browser, so this stays true as Chromium updates and never
 * claims a version that is not running.
 */
function presentableUserAgent(version: string): string {
  const major = version.split(".")[0] ?? "141";
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";

  return (
    `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`
  );
}
