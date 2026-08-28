/**
 * Computer use: driving the machine the way a person does.
 *
 * A worker sees a screenshot and acts on pixels — move, click, drag, scroll,
 * type, press. This is a first-class control method, not a fallback. It is what
 * makes the long tail reachable: canvas seat maps, drag-to-reorder, custom
 * widgets, anything a site built without regard for its accessibility tree.
 *
 * The action vocabulary here is deliberately *not* invented. It mirrors the
 * shape both major providers already emit — Anthropic's `computer_*` tool and
 * OpenAI's `computer-use-preview` — so a model the user chose drives this
 * machine with no per-provider translation layer of ours in the hot path. That
 * is what makes "pick your own model" real rather than aspirational.
 *
 * Two things that are easy to get wrong and are handled here rather than left to
 * the caller:
 *
 * 1. **Coordinate space.** A model reasons about the screenshot it was given. If
 *    that image was downscaled from the real viewport and the coordinates are
 *    replayed unscaled, every click lands short — consistently, silently, and in
 *    a way that looks like the model being bad at its job. Coordinates are
 *    translated explicitly, in one place, with the scale factor recorded.
 *
 * 2. **Authority is unaffected by perception.** A click expressed as pixels is
 *    still a click. It carries the same operation class as a targeted one, so it
 *    meets the same spend gate, origin allowlist, and audit trail. Seeing
 *    differently never means being allowed to do more.
 */

import { z } from "zod";

/** Where a pointer action lands, in the coordinate space of the screenshot. */
export const pointSchema = z.object({
  x: z.number().int().nonnegative().max(20_000),
  y: z.number().int().nonnegative().max(20_000),
});

export type Point = z.infer<typeof pointSchema>;

/**
 * Keys nameable in a chord. Bounded on purpose: an open string would be a
 * pass-through to whatever the automation layer's key parser accepts, and that
 * parser is not a security boundary we own.
 */
export const KEY_NAMES = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Insert",
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "a",
  "c",
  "v",
  "x",
  "z",
  "f",
  "l",
  "t",
  "w",
  "r",
] as const;

export const keyNameSchema = z.enum(KEY_NAMES);
export type KeyName = z.infer<typeof keyNameSchema>;

/** Modifiers a pointer action may hold down. */
export const modifierSchema = z.enum(["Control", "Alt", "Shift", "Meta"]);
export type Modifier = z.infer<typeof modifierSchema>;

const modifiers = z.array(modifierSchema).max(4).default([]);

/**
 * The canonical computer action set.
 *
 * Covers the union of what Anthropic and OpenAI computer-use models emit, so
 * neither provider's output has to be lossily squeezed into the other's shape.
 */
export const computerActionSchema = z.discriminatedUnion("action", [
  /** Look. The one action every loop begins with. */
  z.object({ action: z.literal("screenshot") }),
  z.object({ action: z.literal("cursor_position") }),

  z.object({ action: z.literal("mouse_move"), coordinate: pointSchema }),
  z.object({ action: z.literal("left_click"), coordinate: pointSchema, modifiers }),
  z.object({ action: z.literal("right_click"), coordinate: pointSchema, modifiers }),
  z.object({ action: z.literal("middle_click"), coordinate: pointSchema, modifiers }),
  z.object({ action: z.literal("double_click"), coordinate: pointSchema, modifiers }),
  /** Selects a whole line — how a model clears a field it cannot see the end of. */
  z.object({ action: z.literal("triple_click"), coordinate: pointSchema, modifiers }),

  /**
   * Held-button primitives. Some widgets — canvas drawing, range sliders,
   * kanban columns — only respond to a press that stays down across moves, which
   * a compound drag action cannot express.
   */
  z.object({ action: z.literal("left_mouse_down"), coordinate: pointSchema.optional() }),
  z.object({ action: z.literal("left_mouse_up"), coordinate: pointSchema.optional() }),

  /** Straight-line drag: the common case, and what Anthropic's tool emits. */
  z.object({
    action: z.literal("left_click_drag"),
    start_coordinate: pointSchema,
    coordinate: pointSchema,
  }),
  /**
   * Multi-point drag. Some anti-bot sliders reject a perfectly straight path,
   * and some canvases need a real curve.
   */
  z.object({
    action: z.literal("drag_path"),
    path: z.array(pointSchema).min(2).max(64),
  }),

  /**
   * Scroll at a point rather than at the page. Inner scroll containers — map
   * panes, modal bodies, virtualised lists — do not move when the page does.
   */
  z.object({
    action: z.literal("scroll"),
    coordinate: pointSchema,
    scroll_direction: z.enum(["up", "down", "left", "right"]),
    scroll_amount: z.number().int().positive().max(30).default(3),
  }),

  z.object({ action: z.literal("type"), text: z.string().max(4000) }),
  /** A chord: ["Control","l"] focuses the address bar. */
  z.object({ action: z.literal("key"), keys: z.array(keyNameSchema).min(1).max(4) }),
  z.object({
    action: z.literal("hold_key"),
    key: keyNameSchema,
    durationMs: z.number().int().positive().max(10_000),
  }),

  /** Let the page settle. Bounded so a worker cannot idle on a paid machine. */
  z.object({
    action: z.literal("wait"),
    durationMs: z.number().int().positive().max(30_000).default(1000),
  }),
]);

export type ComputerAction = z.infer<typeof computerActionSchema>;

/**
 * Classify a computer action for the taint machine and the policy engine.
 *
 * Returns the same vocabulary the targeted DSL uses. That shared vocabulary is
 * the mechanism behind "perception does not confer authority": the gate that
 * sees a `click` cannot tell, and must not care, whether it arrived as a
 * coordinate or as an accessibility ref.
 */
export function operationClassOfComputerAction(
  action: ComputerAction
): "click" | "type" | "scroll" | "wait" | "screenshot" | "read-text" {
  switch (action.action) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
    case "left_mouse_down":
    case "left_mouse_up":
    case "left_click_drag":
    case "drag_path":
    case "mouse_move":
      return "click";
    case "type":
    case "key":
    case "hold_key":
      return "type";
    case "scroll":
      return "scroll";
    case "wait":
      return "wait";
    case "screenshot":
      return "screenshot";
    case "cursor_position":
      return "read-text";
  }
}

/* -------------------------------------------------------------------------- */
/* Coordinate space                                                            */
/* -------------------------------------------------------------------------- */

export interface DisplaySize {
  readonly width: number;
  readonly height: number;
}

/**
 * The resolution screenshots are presented at.
 *
 * Both providers' guidance is the same and worth honouring: send images at or
 * below roughly XGA. Above that the image is resized somewhere in the stack
 * anyway, and a model then reasons in one coordinate space while its clicks are
 * replayed in another.
 */
export const MODEL_DISPLAY: DisplaySize = { width: 1024, height: 768 };

/** The machine's real viewport. Larger, because real pages are laid out for it. */
export const MACHINE_VIEWPORT: DisplaySize = { width: 1440, height: 900 };

export interface CoordinateSpace {
  /** What the model was shown. */
  readonly display: DisplaySize;
  /** What actually exists. */
  readonly viewport: DisplaySize;
}

/**
 * Translate a point from the model's screenshot space into the real viewport.
 *
 * Axes are scaled independently: letterboxing a screenshot to preserve aspect
 * ratio would mean the model wastes part of its image budget on bars, and worse,
 * has to reason about where the content actually starts.
 */
export function toViewport(space: CoordinateSpace, point: Point): Point {
  const scaleX = space.viewport.width / space.display.width;
  const scaleY = space.viewport.height / space.display.height;
  return {
    x: Math.round(point.x * scaleX),
    y: Math.round(point.y * scaleY),
  };
}

/** The inverse, for reporting a real cursor position back to the model. */
export function toDisplay(space: CoordinateSpace, point: Point): Point {
  const scaleX = space.display.width / space.viewport.width;
  const scaleY = space.display.height / space.viewport.height;
  return {
    x: Math.round(point.x * scaleX),
    y: Math.round(point.y * scaleY),
  };
}

/**
 * A point outside the image the model was shown is not a near miss to be
 * clamped — it means the model is reasoning about a different screen than the
 * one it is driving. Clamping would turn that into a plausible-looking click
 * somewhere on the edge of the page; erroring surfaces it.
 */
export function assertOnScreen(space: CoordinateSpace, point: Point): void {
  if (point.x >= space.display.width || point.y >= space.display.height) {
    throw new Error(
      `Coordinate (${String(point.x)}, ${String(point.y)}) is outside the ${String(space.display.width)}x${String(space.display.height)} screen.`
    );
  }
}

/** Rewrite every coordinate an action carries into viewport space. */
export function projectAction(space: CoordinateSpace, action: ComputerAction): ComputerAction {
  const project = (point: Point): Point => {
    assertOnScreen(space, point);
    return toViewport(space, point);
  };

  switch (action.action) {
    case "mouse_move":
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
    case "scroll":
      return { ...action, coordinate: project(action.coordinate) };
    case "left_mouse_down":
    case "left_mouse_up":
      return action.coordinate ? { ...action, coordinate: project(action.coordinate) } : action;
    case "left_click_drag":
      return {
        ...action,
        start_coordinate: project(action.start_coordinate),
        coordinate: project(action.coordinate),
      };
    case "drag_path":
      return { ...action, path: action.path.map(project) };
    default:
      return action;
  }
}

/* -------------------------------------------------------------------------- */
/* Provider bridging                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The tool definition handed to an Anthropic model.
 *
 * `display_width_px`/`display_height_px` must match the screenshots actually
 * sent, which is why they are derived from the same `DisplaySize` value the
 * capture path uses rather than written out as constants.
 */
export function anthropicToolSpec(display: DisplaySize = MODEL_DISPLAY): Record<string, unknown> {
  return {
    type: "computer_20250124",
    name: "computer",
    display_width_px: display.width,
    display_height_px: display.height,
  };
}

/** The equivalent for OpenAI's computer-use models. */
export function openaiToolSpec(display: DisplaySize = MODEL_DISPLAY): Record<string, unknown> {
  return {
    type: "computer_use_preview",
    display_width: display.width,
    display_height: display.height,
    environment: "browser",
  };
}

/**
 * The tool definition for every other model.
 *
 * A model without a native computer-use tool — a self-hosted vision model, or a
 * provider that has not shipped one — drives the same machine through an
 * ordinary JSON-schema tool. Capability, not vendor, decides what a deployment
 * can run.
 */
export function genericToolSpec(display: DisplaySize = MODEL_DISPLAY): Record<string, unknown> {
  return {
    name: "computer",
    description:
      `Control a computer by looking at screenshots and acting on them. The screen is ` +
      `${String(display.width)}x${String(display.height)} pixels; (0,0) is the top-left corner. ` +
      `Take a screenshot first, then act on what you see.`,
    input_schema: z.toJSONSchema(computerActionSchema),
  };
}

const anthropicActionSchema = z.object({
  action: z.string(),
  coordinate: z.tuple([z.number(), z.number()]).optional(),
  start_coordinate: z.tuple([z.number(), z.number()]).optional(),
  text: z.string().optional(),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
  scroll_amount: z.number().optional(),
  duration: z.number().optional(),
});

const point = (pair: readonly [number, number]): Point => ({
  x: Math.round(pair[0]),
  y: Math.round(pair[1]),
});

const asModifiers = (text: string | undefined): Modifier[] =>
  (text ?? "")
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .flatMap((part): Modifier[] => {
      if (part === "ctrl" || part === "control") return ["Control"];
      if (part === "alt" || part === "option") return ["Alt"];
      if (part === "shift") return ["Shift"];
      if (part === "cmd" || part === "super" || part === "meta") return ["Meta"];
      return [];
    });

/**
 * Parse what an Anthropic computer-use model emitted.
 *
 * Returns undefined rather than throwing on an unrecognised action: a model
 * inventing an action is a normal event to report back into the loop, not an
 * exception that should tear down a task mid-flight.
 */
export function fromAnthropicAction(raw: unknown): ComputerAction | undefined {
  const parsed = anthropicActionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const a = parsed.data;
  const at = a.coordinate ? point(a.coordinate) : undefined;
  const mods = asModifiers(a.text);

  switch (a.action) {
    case "screenshot":
      return { action: "screenshot" };
    case "cursor_position":
      return { action: "cursor_position" };
    case "mouse_move":
      return at ? { action: "mouse_move", coordinate: at } : undefined;
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      return at ? { action: a.action, coordinate: at, modifiers: mods } : undefined;
    case "left_mouse_down":
    case "left_mouse_up":
      return { action: a.action, coordinate: at };
    case "left_click_drag":
      return a.start_coordinate && at
        ? {
            action: "left_click_drag",
            start_coordinate: point(a.start_coordinate),
            coordinate: at,
          }
        : undefined;
    case "scroll":
      return at && a.scroll_direction
        ? {
            action: "scroll",
            coordinate: at,
            scroll_direction: a.scroll_direction,
            scroll_amount: Math.min(30, Math.max(1, Math.round(a.scroll_amount ?? 3))),
          }
        : undefined;
    case "type":
      return a.text === undefined ? undefined : { action: "type", text: a.text };
    case "key": {
      const keys = keyChord(a.text);
      return keys ? { action: "key", keys } : undefined;
    }
    case "hold_key": {
      const keys = keyChord(a.text);
      return keys?.[0]
        ? {
            action: "hold_key",
            key: keys[0],
            durationMs: Math.round((a.duration ?? 1) * 1000),
          }
        : undefined;
    }
    case "wait":
      return { action: "wait", durationMs: Math.round((a.duration ?? 1) * 1000) };
    default:
      return undefined;
  }
}

/** Anthropic sends chords as xdotool-style strings: "ctrl+l", "Return". */
function keyChord(text: string | undefined): [KeyName, ...KeyName[]] | undefined {
  if (!text) return undefined;
  const aliases: Record<string, KeyName> = {
    ctrl: "Control",
    control: "Control",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    cmd: "Meta",
    super: "Meta",
    meta: "Meta",
    return: "Enter",
    enter: "Enter",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    page_up: "PageUp",
    page_down: "PageDown",
    home: "Home",
    end: "End",
  };

  const keys: KeyName[] = [];
  for (const part of text.split("+").map((p) => p.trim())) {
    const mapped = aliases[part.toLowerCase()];
    if (mapped) {
      keys.push(mapped);
      continue;
    }
    const direct = keyNameSchema.safeParse(part.length === 1 ? part.toLowerCase() : part);
    if (!direct.success) return undefined;
    keys.push(direct.data);
  }

  const [first, ...rest] = keys;
  return first ? [first, ...rest] : undefined;
}

const openaiActionSchema = z.object({
  type: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  button: z.string().optional(),
  path: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  keys: z.array(z.string()).optional(),
  text: z.string().optional(),
  scroll_x: z.number().optional(),
  scroll_y: z.number().optional(),
});

/** Parse what an OpenAI computer-use model emitted. */
export function fromOpenAIAction(raw: unknown): ComputerAction | undefined {
  const parsed = openaiActionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const a = parsed.data;
  const at =
    a.x === undefined || a.y === undefined ? undefined : { x: Math.round(a.x), y: Math.round(a.y) };

  switch (a.type) {
    case "screenshot":
      return { action: "screenshot" };
    case "move":
      return at ? { action: "mouse_move", coordinate: at } : undefined;
    case "click": {
      if (!at) return undefined;
      if (a.button === "right") return { action: "right_click", coordinate: at, modifiers: [] };
      if (a.button === "wheel") return { action: "middle_click", coordinate: at, modifiers: [] };
      return { action: "left_click", coordinate: at, modifiers: [] };
    }
    case "double_click":
      return at ? { action: "double_click", coordinate: at, modifiers: [] } : undefined;
    case "drag": {
      const path = a.path?.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) ?? [];
      const [start, ...rest] = path;
      if (!start || rest.length === 0) return undefined;
      return { action: "drag_path", path: [start, ...rest] };
    }
    case "scroll": {
      if (!at) return undefined;
      // OpenAI expresses scroll as a pixel delta on each axis; the larger
      // magnitude is the axis the model actually meant to move.
      const dx = a.scroll_x ?? 0;
      const dy = a.scroll_y ?? 0;
      const vertical = Math.abs(dy) >= Math.abs(dx);
      const delta = vertical ? dy : dx;
      if (delta === 0) return undefined;
      return {
        action: "scroll",
        coordinate: at,
        scroll_direction: vertical ? (delta > 0 ? "down" : "up") : delta > 0 ? "right" : "left",
        // ~100px per wheel click is the conventional ratio.
        scroll_amount: Math.min(30, Math.max(1, Math.round(Math.abs(delta) / 100))),
      };
    }
    case "type":
      return a.text === undefined ? undefined : { action: "type", text: a.text };
    case "keypress": {
      const keys = a.keys?.map((k) => keyChord(k)?.[0]).filter((k): k is KeyName => Boolean(k));
      const [first, ...rest] = keys ?? [];
      return first ? { action: "key", keys: [first, ...rest] } : undefined;
    }
    case "wait":
      return { action: "wait", durationMs: 1000 };
    default:
      return undefined;
  }
}
