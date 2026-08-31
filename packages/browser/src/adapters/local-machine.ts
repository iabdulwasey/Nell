/**
 * A persistent machine on the local filesystem.
 *
 * The self-host implementation of `MachineHost`, and the one CI exercises. It is
 * a real implementation of the same semantics a cloud vendor provides, not a
 * degraded stand-in: the machine's identity lives in a Chromium profile
 * directory, so cookies, storage, and logins survive standby, process restarts,
 * and reboots — which is the entire point of a persistent machine.
 *
 * `standby` closes the browser and leaves the profile on disk. For a local
 * machine that IS the cheap state: nothing is running, everything is retained,
 * and waking is a launch rather than a login.
 *
 * Machine metadata (when it was created, how much work it has done) lives in the
 * profile directory beside the browser state rather than in the caller's memory.
 * A machine's age is the trust it has accrued with the sites it visits, and
 * losing that number to a process restart would silently reset the one property
 * that only time can rebuild.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page, type Route } from "playwright-core";
import {
  MODEL_DISPLAY,
  type ComputerAction,
  type CoordinateSpace,
  type Point,
} from "../computer.js";
import type {
  ActOutcome,
  Captured,
  CaptureUrlOptions,
  Downloaded,
  DownloadOptions,
  Machine,
  MachineHost,
} from "../machine.js";
import { runComputerActions, type CaptureOptions } from "./computer-exec.js";

export interface LocalMachineOptions {
  /** Root directory holding one profile per machine. */
  readonly root: string;
  readonly headless?: boolean;
  /** The machine's real screen. Real pages are laid out for a real screen. */
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly now?: () => number;
}

/** What survives a restart, stored beside the browser profile. */
interface MachineRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: number;
  readonly scratch: boolean;
}

interface Live {
  readonly context: BrowserContext;
  readonly page: Page;
  cursor: Point;
}

/**
 * The SSRF guard, as a route handler that cannot take the process down.
 *
 * **This crashed the agent in the field**, on an ordinary request — *"book me a
 * romantic movie near UC Berkeley"* — and the crash is worth reading closely
 * because the guard itself was right.
 *
 * `allow` resolves DNS, which is slow. In that window the page can navigate, be
 * closed, or have the route settled another way; `route.continue()` then throws
 * **"Route is already handled!"**. A throw inside a Playwright route handler
 * becomes an *unhandled promise rejection* — nobody is awaiting it — and Node
 * ends the process. So a benign race in a security check killed a running
 * agent, mid-task, with a stack trace the user saw as silence.
 *
 * Two things are wrong with the original and both are fixed here. A route that
 * is already handled is **not an error**: the request is gone, which is the
 * outcome either branch was working towards. And a check that cannot be
 * completed must **fail closed** — aborting rather than continuing — because
 * "we could not decide" and "it is allowed" are different answers and only one
 * of them is safe.
 */
export function guardForTest(allow: (url: string) => Promise<boolean>) {
  return guard(allow);
}

function guard(allow: (url: string) => Promise<boolean>) {
  return async (route: Route): Promise<void> => {
    let permitted = false;
    try {
      permitted = await allow(route.request().url());
    } catch {
      // Fail closed: an undecidable request is refused, not waved through.
      permitted = false;
    }

    try {
      if (permitted) await route.continue();
      else await route.abort("blockedbyclient");
    } catch {
      /**
       * Already handled, or the page went away. Either way the request no
       * longer exists and there is nothing to decide about it — which is a
       * normal end to a navigation, not a reason to end the process.
       */
    }
  };
}

export class LocalMachineHost implements MachineHost {
  readonly #options: LocalMachineOptions;
  readonly #now: () => number;
  readonly #live = new Map<string, Live>();
  #counter = 0;

  constructor(options: LocalMachineOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    mkdirSync(options.root, { recursive: true });
  }

  /** How the model's screenshot relates to the real screen. */
  coordinateSpace(): CoordinateSpace {
    const viewport = this.#options.viewport ?? { width: 1440, height: 900 };
    const factor = Math.min(1, MODEL_DISPLAY.width / viewport.width);
    return {
      viewport,
      display: {
        width: Math.round(viewport.width * factor),
        height: Math.round(viewport.height * factor),
      },
    };
  }

  async provision(workspaceId: string, options: { readonly scratch: boolean }): Promise<Machine> {
    this.#counter += 1;
    const id = `local-machine-${String(process.pid)}-${String(this.#counter)}`;
    const record: MachineRecord = {
      id,
      workspaceId,
      createdAt: this.#now(),
      scratch: options.scratch,
    };

    mkdirSync(this.#profileDir(id), { recursive: true });
    writeFileSync(this.#recordPath(id), JSON.stringify(record), "utf8");

    await this.#launch(id);
    return this.#describe(record, "running");
  }

  /**
   * Wake a suspended machine.
   *
   * Relaunching against the same profile directory is what makes the machine the
   * same machine: Chromium reads back its cookie jar and storage, so the site
   * that trusted this browser yesterday still does.
   */
  async resume(machineId: string): Promise<Machine> {
    const record = this.#readRecord(machineId);
    if (!this.#live.has(machineId)) await this.#launch(machineId);
    return this.#describe(record, "running");
  }

  /** Suspend: stop the browser, keep everything it knows. */
  async standby(machineId: string): Promise<void> {
    const live = this.#live.get(machineId);
    if (!live) return;
    this.#live.delete(machineId);
    await live.context.close();
  }

  async act(machineId: string, action: ComputerAction): Promise<ActOutcome> {
    return this.actBatch(machineId, [action]);
  }

  /**
   * Run several actions in one go.
   *
   * Batching matters more than perception mode for what a task costs: it is the
   * difference between one model round-trip and ten.
   */
  async actBatch(
    machineId: string,
    actions: readonly ComputerAction[],
    options: CaptureOptions = {}
  ): Promise<ActOutcome> {
    const live = this.#live.get(machineId) ?? (await this.#launch(machineId));
    const outcome = await runComputerActions(
      live.page,
      actions,
      this.coordinateSpace(),
      live.cursor,
      options
    );
    live.cursor = outcome.cursor;

    return {
      screenshot: outcome.screenshot,
      currentOrigin: originOf(live.page.url()),
      currentUrl: live.page.url(),
      cursor: outcome.cursor,
    };
  }

  /** Open a URL. See `MachineHost.navigate` for why this is an operation. */
  async navigate(machineId: string, url: string): Promise<ActOutcome> {
    if (!isNavigable(url)) {
      throw new Error("Navigation must be an http(s) URL.");
    }

    const live = this.#live.get(machineId) ?? (await this.#launch(machineId));
    await live.page.goto(url, { waitUntil: "domcontentloaded" });

    return {
      currentOrigin: originOf(live.page.url()),
      currentUrl: live.page.url(),
      cursor: live.cursor,
    };
  }

  /**
   * Read a URL as the browser. See `MachineHost.download`.
   *
   * `page.goto` rather than an HTTP client because the point is to be Chromium:
   * its TLS handshake, its header order, its trust store. All three matter in
   * practice — hosts that refuse a bare fetch serve the file to a browser, and
   * a machine behind a TLS-inspecting network trusts what the system trusts
   * while Node, carrying its own CA bundle, does not.
   *
   * The route guard is installed before the navigation and removed after, and
   * it sees **every** request the page makes rather than just the first. A
   * redirect is a new request; so is an image the page pulls in. A guard that
   * only checked the URL we were handed would be checking the one hop the model
   * already showed us.
   */
  async download(
    machineId: string,
    url: string,
    options: DownloadOptions = {}
  ): Promise<Downloaded> {
    if (!isNavigable(url)) throw new Error("A download must be an http(s) URL.");

    const live = this.#live.get(machineId) ?? (await this.#launch(machineId));
    const { allow } = options;

    if (allow) {
      await live.page.route("**/*", guard(allow));
    }

    try {
      const response = await live.page.goto(url, { waitUntil: "domcontentloaded" });
      if (!response) throw new Error("The browser opened that URL and got nothing back.");

      const bytes = new Uint8Array(await response.body());
      const max = options.maxBytes;
      if (max !== undefined && bytes.length > max) {
        throw new Error("That file is too large.");
      }

      return {
        status: response.status(),
        mediaType: (response.headers()["content-type"] ?? "application/octet-stream")
          .split(";")[0]!
          .trim(),
        bytes,
        finalUrl: response.url(),
      };
    } finally {
      if (allow) await live.page.unroute("**/*");
    }
  }

  /** A picture of a rendered page. See `MachineHost.capture`. */
  async capture(
    machineId: string,
    url: string,
    options: CaptureUrlOptions = {}
  ): Promise<Captured> {
    if (!isNavigable(url)) throw new Error("A capture must be an http(s) URL.");

    const live = this.#live.get(machineId) ?? (await this.#launch(machineId));
    const { allow } = options;

    if (allow) {
      await live.page.route("**/*", guard(allow));
    }

    try {
      /**
       * `load` rather than `domcontentloaded`, then a settle.
       *
       * The whole point of this method is pages whose content is drawn after
       * the document exists — maps, charts, anything live. Screenshotting at
       * `domcontentloaded` reliably captures a spinner, which is worse than
       * failing because it looks like it worked.
       */
      await live.page.goto(url, { waitUntil: "load" }).catch(() => undefined);
      await live.page.waitForTimeout(options.settleMs ?? 2500);

      return {
        bytes: new Uint8Array(
          await live.page.screenshot({ type: "png", fullPage: options.fullPage ?? false })
        ),
        finalUrl: live.page.url(),
        title: await live.page.title().catch(() => ""),
      };
    } finally {
      if (allow) await live.page.unroute("**/*");
    }
  }

  /**
   * Irreversible. Throws away every login the machine had accumulated and every
   * day of device trust behind them.
   */
  async destroy(machineId: string): Promise<void> {
    await this.standby(machineId);
    rmSync(this.#profileDir(machineId), { recursive: true, force: true });
  }

  /** Close everything without deleting anything. For process shutdown. */
  async shutdown(): Promise<void> {
    for (const id of [...this.#live.keys()]) await this.standby(id);
  }

  async #launch(machineId: string): Promise<Live> {
    const space = this.coordinateSpace();
    const context = await chromium.launchPersistentContext(this.#profileDir(machineId), {
      headless: this.#options.headless ?? true,
      viewport: { width: space.viewport.width, height: space.viewport.height },
      deviceScaleFactor: space.display.width / space.viewport.width,
    });

    const page = context.pages()[0] ?? (await context.newPage());
    const live: Live = { context, page, cursor: { x: 0, y: 0 } };
    this.#live.set(machineId, live);
    return live;
  }

  #profileDir(machineId: string): string {
    return join(this.#options.root, machineId);
  }

  #recordPath(machineId: string): string {
    return join(this.#profileDir(machineId), "nell-machine.json");
  }

  #readRecord(machineId: string): MachineRecord {
    try {
      return JSON.parse(readFileSync(this.#recordPath(machineId), "utf8")) as MachineRecord;
    } catch {
      throw new Error(`No machine ${machineId}.`);
    }
  }

  #describe(record: MachineRecord, state: Machine["state"]): Machine {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      state,
      createdAt: record.createdAt,
      lastUsedAt: this.#now(),
      tasksServed: 0,
      viewport: this.coordinateSpace().viewport,
      scratch: record.scratch,
    };
  }
}

function isNavigable(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "about:blank";
  }
}
