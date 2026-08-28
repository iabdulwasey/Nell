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
}

export interface LocalBrowserOptions {
  readonly headless?: boolean;
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
    const context = await browser.newContext();
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
    this.#sessions.set(session.id, { session, context, page });
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
