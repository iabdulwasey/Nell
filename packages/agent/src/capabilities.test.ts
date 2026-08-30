/**
 * What a model can do, and what the user is told about it.
 *
 * The tests that matter are the ones about being *told*. A capability map that
 * is correct and invisible is what already existed: computed at boot from
 * whichever keys were present, never shown, and discovered when a task failed.
 */

import { describe, expect, it } from "vitest";
import {
  capabilitiesOf,
  describe as describeReport,
  report,
  resolve,
  type Lookup,
} from "./capabilities.js";

const MODELS: Record<string, { provider: string; supportsVision: boolean }> = {
  "anthropic/claude-sonnet-4-5": { provider: "anthropic", supportsVision: true },
  "openai/gpt-5": { provider: "openai", supportsVision: true },
  "deepseek/deepseek-v3": { provider: "deepseek", supportsVision: false },
  "google/gemini-3-pro": { provider: "google", supportsVision: true },
};

const lookup: Lookup = (id) => MODELS[id];

describe("what a model can do", () => {
  it("knows Claude reads and runs code but does not draw", () => {
    const can = capabilitiesOf(MODELS["anthropic/claude-sonnet-4-5"]!);

    expect(can.has("code")).toBe(true);
    expect(can.has("search")).toBe(true);
    expect(can.has("vision")).toBe(true);
    // The gap the whole feature exists to make visible.
    expect(can.has("image")).toBe(false);
  });

  it("knows GPT covers nearly everything", () => {
    const can = capabilitiesOf(MODELS["openai/gpt-5"]!);
    for (const capability of ["text", "vision", "search", "code", "image"] as const) {
      expect(can.has(capability), capability).toBe(true);
    }
  });

  /**
   * Vision varies within a vendor where the others do not — it is a property of
   * the model, and it is the reason the frontier tier refuses a text-only one.
   */
  it("takes vision from the model, not the vendor", () => {
    expect(capabilitiesOf(MODELS["deepseek/deepseek-v3"]!).has("vision")).toBe(false);
    expect(capabilitiesOf({ provider: "deepseek", supportsVision: true }).has("vision")).toBe(true);
  });

  it("assumes nothing about an unknown vendor beyond text", () => {
    const can = capabilitiesOf({ provider: "something-new", supportsVision: false });
    expect([...can]).toEqual(["text"]);
  });
});

/** Every vendor paid for, so these cases isolate model choice from key presence. */
const paid = () => true;

describe("who handles what", () => {
  it("sends everything to one model when that is all there is", () => {
    const resolved = resolve({ defaultModel: "openai/gpt-5" }, lookup, paid);
    expect(resolved.every((entry) => entry.modelId === "openai/gpt-5" || !entry.modelId)).toBe(
      true
    );
    expect(resolved.some((entry) => entry.delegated)).toBe(false);
  });

  /** The arrangement that makes an install complete when no single vendor is. */
  it("hands drawing to a vendor that draws, and keeps the rest", () => {
    const resolved = resolve(
      {
        defaultModel: "anthropic/claude-sonnet-4-5",
        overrides: { image: "openai/gpt-5" },
      },
      lookup,
      paid
    );

    const image = resolved.find((entry) => entry.capability === "image");
    expect(image?.modelId).toBe("openai/gpt-5");
    expect(image?.delegated).toBe(true);

    // Reasoning stays with the model the user chose.
    expect(resolved.find((entry) => entry.capability === "code")?.modelId).toBe(
      "anthropic/claude-sonnet-4-5"
    );
  });

  /**
   * A user who assigns drawing to a model that cannot draw has made a mistake.
   * Obeying it silently produces a failure when the task runs; refusing it
   * produces a correction while they are still looking at the setting.
   */
  it("ignores an override the chosen model cannot honour", () => {
    const resolved = resolve(
      {
        defaultModel: "openai/gpt-5",
        overrides: { image: "deepseek/deepseek-v3" },
      },
      lookup,
      paid
    );

    expect(resolved.find((entry) => entry.capability === "image")?.modelId).toBe("openai/gpt-5");
  });

  it("leaves a capability unassigned when nothing can do it", () => {
    const resolved = resolve({ defaultModel: "deepseek/deepseek-v3" }, lookup, paid);
    const image = resolved.find((entry) => entry.capability === "image");
    expect(image?.modelId).toBeUndefined();
  });
});

describe("what the user is told", () => {
  it("names the gap and the key that closes it", () => {
    const result = report(
      { defaultModel: "anthropic/claude-sonnet-4-5" },
      lookup,
      new Set(["anthropic"])
    );

    expect(result.cannot).toContain("image");
    expect(result.can).toContain("code");
    expect(result.wouldFix.length).toBeGreaterThan(0);

    const said = describeReport(result);
    expect(said).toContain("Generate images");
    expect(said).toContain("What I can't");
    // A key they could actually add, not a shrug.
    expect(said).toContain("Add a key from OpenAI");
  });

  /**
   * Ranked by how much of the gap each closes: offering four vendors that add
   * one thing each is a worse answer than one that adds three.
   */
  it("suggests the vendor that closes most of the gap first", () => {
    const result = report({ defaultModel: "deepseek/deepseek-v3" }, lookup, new Set(["deepseek"]));
    expect(result.wouldFix[0]).toBe("openai");
  });

  /**
   * The behaviour the whole settings design turns on, stated as a pair.
   *
   * Someone who picks a model covering everything should be asked for nothing —
   * no second key, no per-capability choice, silence. Someone who picks a model
   * that cannot draw should be told so *while they are choosing*, not when a
   * task fails. Both fall out of the same computation, which is why they are
   * asserted together: it is the contrast that is the feature.
   */
  it("says nothing to a user whose model covers everything", () => {
    const result = report({ defaultModel: "openai/gpt-5" }, lookup, new Set(["openai"]));
    expect(result.cannot).toHaveLength(0);
    expect(result.needsKey).toHaveLength(0);

    const said = describeReport(result);
    expect(said).not.toContain("What I can't");
    expect(said).not.toContain("Waiting on a key");
  });

  /**
   * A capability needs a model **and** a key, and this is the case that proved
   * it did not.
   *
   * With only an Anthropic key and Google chosen as the default, the report
   * claimed image generation, audio and embeddings — every one of them needing
   * a Google key that did not exist. The key set was consulted only to rank
   * suggestions, never to decide availability, so a settings screen built on it
   * would have been confidently wrong about exactly the thing the person was
   * about to rely on.
   */
  it("does not claim what an unpaid vendor would do", () => {
    const result = report({ defaultModel: "google/gemini-3-pro" }, lookup, new Set(["anthropic"]));

    expect(result.can).not.toContain("image");
    expect(result.can).not.toContain("text");
    expect(result.needsKey.map((entry) => entry.capability)).toContain("image");
    expect(result.needsKey.every((entry) => entry.vendor === "google")).toBe(true);
  });

  /**
   * Two gaps that read the same and are fixed differently.
   *
   * *Nothing can do this* means choose a model. *A model is chosen and unpaid*
   * means paste a key. Telling somebody to pick an image model when they have
   * already picked one is a note that reads as the software being broken.
   */
  it("distinguishes 'choose a model' from 'add a key'", () => {
    const result = report(
      { defaultModel: "anthropic/claude-sonnet-4-5", overrides: { image: "openai/gpt-5" } },
      lookup,
      new Set(["anthropic"])
    );

    // Chosen, and unpaid: a key closes it.
    expect(result.needsKey).toEqual([{ capability: "image", vendor: "openai" }]);
    expect(result.cannot).not.toContain("image");

    const said = describeReport(result);
    expect(said).toContain("Waiting on a key");
    expect(said).toContain("add your OpenAI key");
  });

  /** One key, asked for once, however many capabilities are waiting on it. */
  it("groups several waiting capabilities under the single key that unlocks them", () => {
    const said = describeReport(
      report({ defaultModel: "google/gemini-3-pro" }, lookup, new Set(["anthropic"]))
    );
    expect(said.match(/add your Google key/gu)).toHaveLength(1);
  });

  /**
   * Found by running it against the real catalog rather than a fixture: an
   * override naming a model id that does not exist was dropped in silence, and
   * the report then said the capability was unavailable — technically true, and
   * useless to somebody looking straight at the key they just added.
   */
  it("says when an override could not be used, and why", () => {
    const unknown = report(
      { defaultModel: "anthropic/claude-sonnet-4-5", overrides: { image: "openai/gpt-typo" } },
      lookup,
      new Set(["anthropic", "openai"])
    );

    expect(unknown.ignored).toHaveLength(1);
    expect(unknown.ignored[0]?.reason).toBe("unknown-model");
    expect(describeReport(unknown)).toContain("don't know the model");

    const incapable = report(
      { defaultModel: "openai/gpt-5", overrides: { image: "deepseek/deepseek-v3" } },
      lookup,
      new Set(["openai"])
    );

    expect(incapable.ignored[0]?.reason).toBe("cannot-do-it");
    expect(describeReport(incapable)).toContain("can't do that");
  });

  /** A delegated capability is shown as delegated, so the bill is not a surprise. */
  it("shows which capabilities go to another model", () => {
    const result = report(
      { defaultModel: "anthropic/claude-sonnet-4-5", overrides: { image: "openai/gpt-5" } },
      lookup,
      new Set(["anthropic", "openai"])
    );

    expect(result.cannot).not.toContain("image");
    expect(describeReport(result)).toContain("Generate images — via openai/gpt-5");
  });
});
