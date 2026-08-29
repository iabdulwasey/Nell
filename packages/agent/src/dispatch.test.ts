/**
 * Choosing how to do a job.
 *
 * The layer whose absence made a resume review fail: with one worker and that
 * worker driving a browser, "read my resume and roast it" opened a browser,
 * which cannot read a file and has no reason to.
 *
 * The tests that matter here are about *not* reaching for the browser. It is the
 * slowest, most fragile and most frequently blocked capability, and the failure
 * mode of a router is that it picks it out of habit.
 */

import { describe, expect, it } from "vitest";
import { explainUnsupported, planWork, unsupported, type Capability } from "./dispatch.js";
import type { ModelProvider } from "./provider.js";

function router(value: unknown): ModelProvider {
  return {
    name: "stub",
    complete: async () => ({ ok: true, value, usage: { inputTokens: 0, outputTokens: 0 } }),
  } as unknown as ModelProvider;
}

const down = {
  name: "stub",
  complete: async () => ({ ok: false, reason: "503", retryable: true }),
} as unknown as ModelProvider;

const base = { model: "m", provider: router({}) };

describe("a question about a file the user sent", () => {
  /**
   * The exact failure. Answered without a model call, because asking a router
   * whether "roast my resume" is about the resume just sent is a round trip to
   * be told something already known.
   */
  it("goes to a model, not a browser, and without asking a router first", async () => {
    let asked = false;
    const watching = {
      name: "stub",
      complete: async () => {
        asked = true;
        return { ok: true, value: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      },
    } as unknown as ModelProvider;

    const plan = await planWork({
      provider: watching,
      model: "m",
      message: "Roast my resume as HBS adcom",
      files: ["resume.pdf"],
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.capability).toBe("assist");
    expect(asked, "no router call needed for a file plus a question").toBe(false);
  });

  /**
   * And producing the rewritten file is the *same* step, not a second one.
   *
   * There used to be an `answer` step feeding a `document` step here. A model
   * that runs code writes the PDF in the same breath as the rewrite, so
   * splitting them was a pipeline doing work the model already does.
   */
  it("does not need a second step to produce the file", async () => {
    const plan = await planWork({
      ...base,
      message: "Rewrite my resume and send me a new PDF",
      files: ["resume.pdf"],
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.capability).toBe("assist");
  });
});

describe("composing capabilities", () => {
  /**
   * The user's example. No single capability does this: pictures come from one
   * model, the file comes from a renderer, and the second needs the first.
   */
  /**
   * "Three images into one PDF" is one step, not two.
   *
   * It was two while drawing was its own capability. Once image generation is a
   * tool the model calls mid-task, the model draws three times and packages them
   * without a plan being written in advance — which is the same lesson as the
   * rest of this file, reached once more from the other direction.
   */
  it("does not need a separate step for pictures", async () => {
    const plan = await planWork({
      ...base,
      provider: router({
        summary: "Making the images, then the PDF.",
        steps: [{ capability: "assist", instruction: "draw three, then package them" }],
      }),
      message: "Create 3 illustrations and pack them into one PDF",
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.capability).toBe("assist");
  });
});

describe("when the model cannot be reached", () => {
  /**
   * Browsing, because it can attempt the widest range of tasks and fails
   * visibly. A wrong "answer" is a confident reply to a question that needed the
   * live web, which is the failure nobody notices.
   */
  it("falls back to browsing for something that plainly acts on a site", async () => {
    const plan = await planWork({ ...base, provider: down, message: "Book me a table at 8" });
    expect(plan.steps[0]?.capability).toBe("browse");
  });

  it("falls back to the model for something that plainly does not", async () => {
    const plan = await planWork({ ...base, provider: down, message: "What is the news today" });
    expect(plan.steps[0]?.capability).toBe("assist");
  });

  it("does the same when the router answers with nonsense", async () => {
    const plan = await planWork({
      ...base,
      provider: router({ steps: [{ capability: "teleport", instruction: "x" }] }),
      message: "Book me a table at 8",
    });
    expect(plan.steps[0]?.capability).toBe("browse");
  });
});

describe("capabilities that are not bound", () => {
  /**
   * Telling someone their agent cannot generate images, and why, is worth more
   * than a broken attempt or a silent omission from the result.
   */
  it("names what is missing rather than failing quietly", () => {
    const bound = new Set<Capability>(["browse"]);
    const missing = unsupported(
      [
        { capability: "assist", instruction: "write it up" },
        { capability: "browse", instruction: "open the page" },
      ],
      bound
    );

    expect(missing).toEqual(["assist"]);
    expect(explainUnsupported(missing)).toContain("work that out");
    expect(explainUnsupported(missing)).toContain("model key");
  });

  it("says nothing when everything is available", () => {
    const bound = new Set<Capability>(["assist", "browse"]);
    expect(unsupported([{ capability: "assist", instruction: "x" }], bound)).toHaveLength(0);
  });
});
