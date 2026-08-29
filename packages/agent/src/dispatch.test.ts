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
    expect(plan.steps[0]?.capability).toBe("answer");
    expect(asked, "no router call needed for a file plus a question").toBe(false);
  });

  /** Unless the ask is for a *new* file, which is a different job. */
  it("still routes when the user wants a document produced from it", async () => {
    const plan = await planWork({
      ...base,
      provider: router({
        summary: "Rewriting your CV.",
        steps: [
          { capability: "answer", instruction: "rewrite the resume" },
          { capability: "document", instruction: "render it as a PDF" },
        ],
      }),
      message: "Rewrite my resume and send me a new PDF",
      files: ["resume.pdf"],
    });

    expect(plan.steps.map((s) => s.capability)).toEqual(["answer", "document"]);
  });
});

describe("composing capabilities", () => {
  /**
   * The user's example. No single capability does this: pictures come from one
   * model, the file comes from a renderer, and the second needs the first.
   */
  it("chains images into a document", async () => {
    const plan = await planWork({
      ...base,
      provider: router({
        summary: "Making the images, then the PDF.",
        steps: [
          { capability: "image", instruction: "generate three illustrations" },
          { capability: "document", instruction: "put all three into one PDF" },
        ],
      }),
      message: "Create 3 images and pack them into one PDF",
    });

    expect(plan.steps.map((s) => s.capability)).toEqual(["image", "document"]);
    // Each step carries its own brief, or the second has nothing to act on.
    expect(plan.steps[1]?.instruction).toContain("PDF");
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

  it("falls back to search for something that plainly does not", async () => {
    const plan = await planWork({ ...base, provider: down, message: "What is the news today" });
    expect(plan.steps[0]?.capability).toBe("search");
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
    const bound = new Set<Capability>(["answer", "document", "search", "browse"]);
    const missing = unsupported(
      [
        { capability: "image", instruction: "draw" },
        { capability: "document", instruction: "render" },
      ],
      bound
    );

    expect(missing).toEqual(["image"]);
    expect(explainUnsupported(missing)).toContain("generate images");
    expect(explainUnsupported(missing)).toContain("model key");
  });

  it("says nothing when everything is available", () => {
    const bound = new Set<Capability>(["answer", "browse"]);
    expect(unsupported([{ capability: "answer", instruction: "x" }], bound)).toHaveLength(0);
  });
});
