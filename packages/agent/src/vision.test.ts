/**
 * The looking sense.
 *
 * Two things are worth testing without a model: that the vocabulary offered is
 * exactly the vocabulary the executor accepts, and that whatever comes back is
 * checked against it. Everything else about vision is a question for a real
 * screenshot and a real page.
 */

import { computerActionSchema } from "@nell/browser";
import { describe, expect, it } from "vitest";
import type { ModelProvider } from "./provider.js";
import { buildVisionSchema, planFromScreen, VISION_PROMPT } from "./vision.js";

function variants(schema: Record<string, unknown>): string[] {
  const items = (schema["properties"] as Record<string, Record<string, unknown>>)["actions"]?.[
    "items"
  ] as { anyOf?: Record<string, unknown>[]; oneOf?: Record<string, unknown>[] };

  return (items.anyOf ?? items.oneOf ?? [])
    .map((variant) => {
      const action = (variant["properties"] as Record<string, unknown> | undefined)?.["action"] as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      return String(action?.const ?? action?.enum?.[0] ?? "");
    })
    .filter(Boolean);
}

function answering(value: unknown): ModelProvider {
  return {
    name: "stub",
    complete: async () => ({ ok: true, value, usage: { inputTokens: 0, outputTokens: 0 } }),
  } as unknown as ModelProvider;
}

const base = {
  model: "m",
  objective: "find the showtimes",
  screenshot: "iVBORw0KGgo=",
  display: { width: 1024, height: 768 },
  url: "https://example.com",
};

describe("the vocabulary offered to a model that can see", () => {
  /**
   * `screenshot` is a real computer-use action and belongs in the executor, but
   * offering it here is a trap the model falls into every time: asked what to do
   * next, "look at the screen" is always defensible, so it spends a turn taking
   * a picture it is already given. Observed directly — seven consecutive turns
   * of "Looking at the current screen to understand what is displayed", each one
   * a model call that moved nothing.
   */
  it("does not offer to take a screenshot, because one is always supplied", () => {
    expect(variants(buildVisionSchema())).not.toContain("screenshot");
    expect(VISION_PROMPT).toContain("never ask for one");
  });

  /**
   * And the other half: filtering must not quietly drop anything else. A
   * vocabulary that loses `scroll` would be worse than the problem it fixed.
   */
  it("offers everything else the executor accepts", () => {
    const offered = new Set(variants(buildVisionSchema()));

    for (const action of ["left_click", "scroll", "type", "key", "drag_path", "wait"]) {
      expect(offered.has(action), action).toBe(true);
    }

    // One fewer than the full surface, and exactly one.
    const all = computerActionSchema.options.length;
    expect(offered.size).toBe(all - 1);
  });
});

describe("what comes back", () => {
  it("passes through a plan the executor could run", async () => {
    const outcome = await planFromScreen({
      ...base,
      provider: answering({
        reasoning: "Clicking the 9:40pm showing.",
        actions: [{ action: "left_click", coordinate: { x: 100, y: 200 } }],
        done: false,
        answer: "",
      }),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.actions).toHaveLength(1);
  });

  /**
   * The same narrow point the structured path has. Pixels change nothing about
   * it: an action the vocabulary cannot express is an action that does not
   * happen.
   */
  it("refuses an action it cannot express", async () => {
    const outcome = await planFromScreen({
      ...base,
      provider: answering({
        reasoning: "improvising",
        actions: [{ action: "execute_script", code: "fetch('https://evil.example')" }],
        done: false,
        answer: "",
      }),
    });

    expect(outcome.ok).toBe(false);
  });

  /** Finishing with nothing left to click is a valid answer, not a malformed one. */
  it("accepts finishing with no actions", async () => {
    const outcome = await planFromScreen({
      ...base,
      provider: answering({
        reasoning: "Nothing showing.",
        actions: [],
        done: true,
        answer: "Spider-Man isn't playing at any theatre near there tonight.",
      }),
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.plan.done).toBe(true);
      expect(outcome.plan.answer).toContain("isn't playing");
    }
  });

  it("treats a provider failure as a value rather than throwing", async () => {
    const down = {
      name: "stub",
      complete: async () => ({ ok: false, reason: "503", retryable: true }),
    } as unknown as ModelProvider;

    const outcome = await planFromScreen({ ...base, provider: down });
    expect(outcome.ok).toBe(false);
  });
});
