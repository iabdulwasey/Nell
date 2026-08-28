import { describe, expect, it } from "vitest";
import {
  anthropicToolSpec,
  assertOnScreen,
  computerActionSchema,
  fromAnthropicAction,
  fromOpenAIAction,
  genericToolSpec,
  MACHINE_VIEWPORT,
  MODEL_DISPLAY,
  openaiToolSpec,
  operationClassOfComputerAction,
  projectAction,
  toDisplay,
  toViewport,
  type ComputerAction,
  type CoordinateSpace,
} from "./index.js";

const space: CoordinateSpace = { display: MODEL_DISPLAY, viewport: MACHINE_VIEWPORT };

describe("the action surface", () => {
  it("covers what a person does with a computer", () => {
    const actions: ComputerAction[] = [
      { action: "screenshot" },
      { action: "mouse_move", coordinate: { x: 10, y: 10 } },
      { action: "left_click", coordinate: { x: 10, y: 10 }, modifiers: [] },
      { action: "right_click", coordinate: { x: 10, y: 10 }, modifiers: [] },
      { action: "double_click", coordinate: { x: 10, y: 10 }, modifiers: [] },
      { action: "triple_click", coordinate: { x: 10, y: 10 }, modifiers: [] },
      { action: "left_mouse_down", coordinate: { x: 10, y: 10 } },
      { action: "left_mouse_up", coordinate: { x: 20, y: 20 } },
      {
        action: "left_click_drag",
        start_coordinate: { x: 1, y: 1 },
        coordinate: { x: 9, y: 9 },
      },
      {
        action: "drag_path",
        path: [
          { x: 1, y: 1 },
          { x: 5, y: 4 },
        ],
      },
      { action: "scroll", coordinate: { x: 5, y: 5 }, scroll_direction: "down", scroll_amount: 3 },
      { action: "type", text: "hello" },
      { action: "key", keys: ["Control", "l"] },
      { action: "hold_key", key: "Shift", durationMs: 500 },
      { action: "wait", durationMs: 1000 },
      { action: "cursor_position" },
    ];
    for (const action of actions) {
      expect(computerActionSchema.safeParse(action).success).toBe(true);
    }
  });

  // Held-button primitives exist because a compound drag cannot express a press
  // that stays down across several moves.
  it("exposes press and release separately from drag", () => {
    expect(computerActionSchema.safeParse({ action: "left_mouse_down" }).success).toBe(true);
    expect(computerActionSchema.safeParse({ action: "left_mouse_up" }).success).toBe(true);
  });

  it("bounds a wait so a worker cannot idle on a paid machine", () => {
    expect(computerActionSchema.safeParse({ action: "wait", durationMs: 600_000 }).success).toBe(
      false
    );
  });

  it("refuses key names outside the known set", () => {
    expect(computerActionSchema.safeParse({ action: "key", keys: ["rm -rf /"] }).success).toBe(
      false
    );
  });
});

describe("authority is unaffected by perception", () => {
  // The gate that sees a click must not be able to tell how it was aimed.
  it("classifies a pixel click as a click, exactly as a targeted one is", () => {
    expect(
      operationClassOfComputerAction({
        action: "left_click",
        coordinate: { x: 5, y: 5 },
        modifiers: [],
      })
    ).toBe("click");
  });

  it("classifies keyboard input as typing, so the taint machine sees it", () => {
    expect(operationClassOfComputerAction({ action: "type", text: "x" })).toBe("type");
    expect(operationClassOfComputerAction({ action: "key", keys: ["Enter"] })).toBe("type");
  });

  it("gives every action a class", () => {
    const every: ComputerAction[] = [
      { action: "screenshot" },
      { action: "cursor_position" },
      { action: "wait", durationMs: 10 },
      { action: "scroll", coordinate: { x: 1, y: 1 }, scroll_direction: "up", scroll_amount: 1 },
      {
        action: "drag_path",
        path: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      },
    ];
    for (const action of every) {
      expect(operationClassOfComputerAction(action)).toBeTruthy();
    }
  });
});

describe("coordinate space", () => {
  // A model reasons about the image it was given. Replaying those coordinates
  // unscaled lands every click short, consistently and silently.
  it("scales a model's coordinates into the real viewport", () => {
    expect(toViewport(space, { x: 512, y: 384 })).toEqual({ x: 720, y: 450 });
  });

  it("round-trips a point back into the model's space", () => {
    const original = { x: 512, y: 384 };
    expect(toDisplay(space, toViewport(space, original))).toEqual(original);
  });

  it("is the identity when the model sees the machine at its real size", () => {
    const same: CoordinateSpace = { display: MODEL_DISPLAY, viewport: MODEL_DISPLAY };
    expect(toViewport(same, { x: 137, y: 42 })).toEqual({ x: 137, y: 42 });
  });

  // Clamping would turn "reasoning about a different screen" into a plausible
  // click on the edge of the page.
  it("refuses a point outside the screen rather than clamping it", () => {
    expect(() => assertOnScreen(space, { x: MODEL_DISPLAY.width, y: 0 })).toThrow(/outside/iu);
    expect(() => assertOnScreen(space, { x: 0, y: MODEL_DISPLAY.height })).toThrow(/outside/iu);
    expect(() => assertOnScreen(space, { x: 1023, y: 767 })).not.toThrow();
  });

  it("projects every coordinate an action carries", () => {
    const projected = projectAction(space, {
      action: "left_click_drag",
      start_coordinate: { x: 512, y: 384 },
      coordinate: { x: 0, y: 0 },
    });
    expect(projected).toEqual({
      action: "left_click_drag",
      start_coordinate: { x: 720, y: 450 },
      coordinate: { x: 0, y: 0 },
    });
  });

  it("projects each point of a multi-point drag", () => {
    const projected = projectAction(space, {
      action: "drag_path",
      path: [
        { x: 0, y: 0 },
        { x: 512, y: 384 },
      ],
    });
    expect(projected).toMatchObject({
      path: [
        { x: 0, y: 0 },
        { x: 720, y: 450 },
      ],
    });
  });

  it("leaves actions without coordinates alone", () => {
    const action: ComputerAction = { action: "type", text: "hello" };
    expect(projectAction(space, action)).toEqual(action);
  });

  it("propagates the off-screen refusal through projection", () => {
    expect(() =>
      projectAction(space, { action: "left_click", coordinate: { x: 5000, y: 5 }, modifiers: [] })
    ).toThrow(/outside/iu);
  });
});

describe("model agnosticism at the tool boundary", () => {
  // Declared display size must match the screenshots actually sent, or the
  // model reasons in one space while its clicks land in another.
  it("declares the same display size it captures at", () => {
    expect(anthropicToolSpec()).toMatchObject({
      display_width_px: MODEL_DISPLAY.width,
      display_height_px: MODEL_DISPLAY.height,
    });
    expect(openaiToolSpec()).toMatchObject({
      display_width: MODEL_DISPLAY.width,
      display_height: MODEL_DISPLAY.height,
    });
  });

  // Capability, not vendor, decides what a deployment can run.
  it("offers a plain JSON-schema tool for models without a native one", () => {
    const spec = genericToolSpec();
    expect(spec["name"]).toBe("computer");
    expect(String(spec["description"])).toContain("1024x768");
    expect(spec["input_schema"]).toBeTruthy();
  });
});

describe("reading what a model emitted", () => {
  it("parses Anthropic tuple coordinates", () => {
    expect(fromAnthropicAction({ action: "left_click", coordinate: [12, 34] })).toEqual({
      action: "left_click",
      coordinate: { x: 12, y: 34 },
      modifiers: [],
    });
  });

  it("reads modifier keys held during a click", () => {
    expect(
      fromAnthropicAction({ action: "left_click", coordinate: [1, 2], text: "ctrl+shift" })
    ).toMatchObject({ modifiers: ["Control", "Shift"] });
  });

  it("translates xdotool key names", () => {
    expect(fromAnthropicAction({ action: "key", text: "Return" })).toEqual({
      action: "key",
      keys: ["Enter"],
    });
    expect(fromAnthropicAction({ action: "key", text: "ctrl+l" })).toEqual({
      action: "key",
      keys: ["Control", "l"],
    });
  });

  it("converts seconds to milliseconds", () => {
    expect(fromAnthropicAction({ action: "wait", duration: 2 })).toEqual({
      action: "wait",
      durationMs: 2000,
    });
  });

  it("reads Anthropic's start/end drag", () => {
    expect(
      fromAnthropicAction({
        action: "left_click_drag",
        start_coordinate: [1, 2],
        coordinate: [3, 4],
      })
    ).toEqual({
      action: "left_click_drag",
      start_coordinate: { x: 1, y: 2 },
      coordinate: { x: 3, y: 4 },
    });
  });

  it("parses OpenAI's button-tagged click", () => {
    expect(fromOpenAIAction({ type: "click", button: "right", x: 7, y: 8 })).toMatchObject({
      action: "right_click",
      coordinate: { x: 7, y: 8 },
    });
    expect(fromOpenAIAction({ type: "click", button: "left", x: 7, y: 8 })?.action).toBe(
      "left_click"
    );
    expect(fromOpenAIAction({ type: "click", button: "wheel", x: 7, y: 8 })?.action).toBe(
      "middle_click"
    );
  });

  it("parses OpenAI's multi-point drag", () => {
    expect(
      fromOpenAIAction({
        type: "drag",
        path: [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
      })
    ).toMatchObject({
      action: "drag_path",
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
    });
  });

  // OpenAI expresses scroll as a pixel delta per axis; ours is a direction.
  it("converts OpenAI's pixel scroll deltas into a direction", () => {
    expect(fromOpenAIAction({ type: "scroll", x: 5, y: 5, scroll_y: 300 })).toMatchObject({
      scroll_direction: "down",
      scroll_amount: 3,
    });
    expect(fromOpenAIAction({ type: "scroll", x: 5, y: 5, scroll_y: -300 })?.action).toBe("scroll");
    expect(
      fromOpenAIAction({ type: "scroll", x: 5, y: 5, scroll_x: -200, scroll_y: 0 })
    ).toMatchObject({ scroll_direction: "left" });
  });

  it("parses OpenAI keypresses", () => {
    expect(fromOpenAIAction({ type: "keypress", keys: ["Enter"] })).toEqual({
      action: "key",
      keys: ["Enter"],
    });
  });

  // A model inventing an action is a normal event to feed back into the loop,
  // not an exception that should tear down a task mid-flight.
  it("returns nothing for an action it does not recognise", () => {
    expect(fromAnthropicAction({ action: "teleport", coordinate: [1, 2] })).toBeUndefined();
    expect(fromOpenAIAction({ type: "teleport" })).toBeUndefined();
    expect(fromAnthropicAction("not an object")).toBeUndefined();
  });

  it("returns nothing when a required coordinate is missing", () => {
    expect(fromAnthropicAction({ action: "left_click" })).toBeUndefined();
    expect(fromOpenAIAction({ type: "click", button: "left" })).toBeUndefined();
  });
});
