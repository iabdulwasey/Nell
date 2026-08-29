/**
 * Turning computer actions into real browser operations.
 *
 * Extracted so that every surface which drives a page by pixels — the session
 * provider and the persistent-machine host — runs the *same* code. Two
 * implementations of "what does left_click mean" would drift, and the one that
 * drifts is the one that quietly stops masking a screenshot or stops releasing a
 * modifier.
 */

import type { Page } from "playwright-core";
import type { ComputerAction, CoordinateSpace, KeyName, Point } from "../computer.js";
import { projectAction } from "../computer.js";

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
export function playwrightKey(key: KeyName): string {
  return key === "Space" ? " " : key;
}

/**
 * Re-exported from the port so there is one definition. Playwright paints over
 * these selectors before the PNG is encoded, so the value never exists in an
 * image that leaves the machine — as opposed to being redacted afterwards, which
 * would mean it did.
 */
export type { CaptureOptions } from "../provider.js";
import type { CaptureOptions } from "../provider.js";

export interface ComputerRunResult {
  readonly screenshot?: string;
  readonly cursor: Point;
}

export async function screenshotOf(
  page: Page,
  options: CaptureOptions & { readonly fullPage?: boolean } = {}
): Promise<string> {
  const mask = (options.maskSelectors ?? []).map((selector) => page.locator(selector));
  const buffer = await page.screenshot({ fullPage: options.fullPage ?? false, mask });
  return buffer.toString("base64");
}

/**
 * Run a batch of computer actions against a page.
 *
 * Coordinates arrive in the model's screenshot space and are projected here,
 * once, before anything touches the page. A point outside that space raises
 * rather than being clamped onto the edge of the screen.
 */
export async function runComputerActions(
  page: Page,
  actions: readonly ComputerAction[],
  space: CoordinateSpace,
  startCursor: Point,
  options: CaptureOptions = {}
): Promise<ComputerRunResult> {
  let cursor = startCursor;
  let screenshot: string | undefined;

  for (const raw of actions) {
    const action = projectAction(space, raw);

    switch (action.action) {
      case "screenshot":
        screenshot = await screenshotOf(page, options);
        break;
      case "cursor_position":
        break;
      case "mouse_move":
        await page.mouse.move(action.coordinate.x, action.coordinate.y);
        cursor = action.coordinate;
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
          await page.mouse.click(action.coordinate.x, action.coordinate.y, { button, clickCount });
        } finally {
          // Released in reverse, and in a finally: a modifier left stuck down
          // silently corrupts every keystroke for the rest of the task.
          for (const modifier of [...action.modifiers].reverse()) {
            await page.keyboard.up(modifier);
          }
        }
        cursor = action.coordinate;
        break;
      }
      case "left_mouse_down":
        if (action.coordinate) {
          await page.mouse.move(action.coordinate.x, action.coordinate.y);
          cursor = action.coordinate;
        }
        await page.mouse.down();
        break;
      case "left_mouse_up":
        if (action.coordinate) {
          await page.mouse.move(action.coordinate.x, action.coordinate.y);
          cursor = action.coordinate;
        }
        await page.mouse.up();
        break;
      case "left_click_drag":
        await page.mouse.move(action.start_coordinate.x, action.start_coordinate.y);
        await page.mouse.down();
        await page.mouse.move(action.coordinate.x, action.coordinate.y, { steps: 12 });
        await page.mouse.up();
        cursor = action.coordinate;
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
        cursor = rest.at(-1) ?? start;
        break;
      }
      case "scroll": {
        // Moving first is what makes this scroll the container under the
        // pointer rather than the page: map panes, modal bodies and
        // virtualised lists do not move when the document does.
        await page.mouse.move(action.coordinate.x, action.coordinate.y);
        cursor = action.coordinate;
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
        // Chromium applies wheel scrolling on the compositor, so the wheel call
        // returns before the page has actually moved. Without this the very next
        // screenshot shows the pre-scroll frame, and the model concludes the
        // page would not scroll and gives up on content that was there all
        // along. Two frames is a committed paint, not a guess.
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
        // Same guard as the targeted executor, for the same reason: a new action
        // that silently no-ops reports success, and the agent believes it
        // clicked something it never touched.
        const unhandled: never = action;
        throw new Error(`Unhandled computer action: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return { screenshot, cursor };
}
