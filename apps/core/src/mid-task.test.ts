/**
 * Telling a change of goal from a change of approach.
 *
 * The judgement that did not exist, and whose absence let a booking run for a
 * hundred steps after being told to abandon the place it was booking at. The
 * cases below are the three the user named, in their own words from the
 * transcript that exposed this.
 *
 * The fallbacks matter as much as the classifications. Getting this wrong in the
 * direction of `redirect` throws away a task's entire context on a stutter,
 * which is far worse than getting it wrong in the direction of `refine` — where
 * the message still reaches the model, just as a constraint. So every failure
 * path lands on `refine`, and that is asserted rather than assumed.
 */

import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@nell/agent";
import { classifyMidTask } from "./mid-task.js";

const answering = (value: unknown): ModelProvider =>
  ({
    name: "fake",
    complete: async () => ({ ok: true, value, usage: { inputTokens: 0, outputTokens: 0 } }),
  }) as unknown as ModelProvider;

const failing = {
  name: "fake",
  complete: async () => ({ ok: false, reason: "down" }),
} as unknown as ModelProvider;

const about = (provider: ModelProvider) => ({
  provider,
  model: "m",
  objective: "Book 2 good seats at sec 90 mall",
  recently: ["Scrolling down to find INOX Sapphire 90 Mall"],
});

describe("what the message wants", () => {
  /** The one that failed. The goal is now a different goal. */
  it("reads a change of place as a redirect, carrying the rest of the goal", async () => {
    const intent = await classifyMidTask("Forget sec 90 mall. Book anyone close", {
      ...about(
        answering({
          kind: "redirect",
          objective: "Book 2 good seats for Spider-Man at any cinema nearby after 9pm",
        })
      ),
    });

    expect(intent.kind).toBe("redirect");
    if (intent.kind !== "redirect") return;
    expect(intent.objective).toContain("any cinema nearby");
    // The abandoned detail must not survive into the new goal, or the loop is
    // handed back the very thing it was told to drop.
    expect(intent.objective).not.toContain("sec 90");
  });

  it("reads a correction about method as a refine", async () => {
    const intent = await classifyMidTask("Don't use bookmyshow, it keeps blocking", {
      ...about(answering({ kind: "refine", constraint: "Do not use bookmyshow; it blocks us." })),
    });

    expect(intent.kind).toBe("refine");
    if (intent.kind !== "refine") return;
    expect(intent.constraint).toContain("bookmyshow");
  });

  it("reads unrelated work as a new task", async () => {
    const intent = await classifyMidTask("also what's the weather tomorrow", {
      ...about(answering({ kind: "new-task" })),
    });
    expect(intent.kind).toBe("new-task");
  });

  /** Sent again because nothing looked like it was happening. */
  it("recognises the same request arriving twice", async () => {
    const intent = await classifyMidTask("Book 2 good seats at sec 90 mall", {
      ...about(answering({ kind: "repeat" })),
    });
    expect(intent.kind).toBe("repeat");
  });
});

describe("being wrong in the safe direction", () => {
  /**
   * A redirect discards the objective and the whole history. Doing that on the
   * strength of an empty string would leave a task with no goal and no memory,
   * so an incomplete redirect is demoted rather than obeyed.
   */
  it("will not discard a task's context for a redirect with no goal in it", async () => {
    const intent = await classifyMidTask("forget that", {
      ...about(answering({ kind: "redirect", objective: "   " })),
    });

    expect(intent.kind).toBe("refine");
    if (intent.kind !== "refine") return;
    expect(intent.constraint).toBe("forget that");
  });

  it("falls back to a constraint when the model is unavailable", async () => {
    const intent = await classifyMidTask("try another cinema", { ...about(failing) });
    expect(intent.kind).toBe("refine");
    if (intent.kind !== "refine") return;
    expect(intent.constraint).toBe("try another cinema");
  });

  it("falls back to a constraint when the answer makes no sense", async () => {
    const intent = await classifyMidTask("try another cinema", {
      ...about(answering({ kind: "nonsense" })),
    });
    expect(intent.kind).toBe("refine");
  });

  /** A refine with nothing in it still carries what the user actually typed. */
  it("keeps the user's own words when the model returns an empty constraint", async () => {
    const intent = await classifyMidTask("not that one", {
      ...about(answering({ kind: "refine", constraint: "" })),
    });
    expect(intent.kind).toBe("refine");
    if (intent.kind !== "refine") return;
    expect(intent.constraint).toBe("not that one");
  });
});
