/**
 * Who draws, and on whose account.
 *
 * The architecture's rule is one line — `override[capability] ?? (default
 * supports it ? default : nothing)` — and the reason it needs tests is that the
 * failure it prevents is a *billing* failure. Quietly drawing on the account the
 * admin did not choose is the kind of thing discovered on an invoice, and no
 * error is raised at any point.
 *
 * The case that motivated the whole thing is the last one here: Claude reasons,
 * GPT draws. Before this existed, that install reported it could not draw at
 * all, because the picture tool was built from `GOOGLE_API_KEY` and never asked
 * the resolver anything.
 */

import { describe, expect, it } from "vitest";
import { capabilityReport } from "@nell/agent";
import { catalogLookup, drawerFor, overridesFromEnv } from "./assignment.js";

const keys =
  (available: Record<string, string>) =>
  (vendor: string): string | undefined =>
    available[vendor];

const BOTH = keys({ google: "g-key", openai: "o-key" });

describe("reading the admin's choice", () => {
  it("takes one variable per capability", () => {
    expect(
      overridesFromEnv({
        NELL_MODEL_IMAGE: "openai/gpt-image-1",
        NELL_MODEL_CODE: "openai/gpt-5.6",
      })
    ).toEqual({ image: "openai/gpt-image-1", code: "openai/gpt-5.6" });
  });

  it("ignores blank ones rather than treating them as a choice", () => {
    expect(overridesFromEnv({ NELL_MODEL_IMAGE: "   " })).toEqual({});
  });
});

describe("with no override at all", () => {
  it("draws on the default model's own vendor when it can draw", () => {
    const drawer = drawerFor({ defaultModel: "google/gemini-3.5-flash" }, BOTH);
    expect(drawer?.vendor).toBe("google");
    // Not the chat model: the images endpoint has its own, and forwarding
    // `gemini-3.5-flash` to it would 400.
    expect(drawer?.model).toBeUndefined();
  });

  /**
   * The install this project actually runs on. Claude cannot draw, and nothing
   * should pretend otherwise — an absent tool is how the model comes to say "I
   * can't make pictures" instead of drawing something plausible and wrong.
   */
  it("has no drawer when the default model cannot draw and nothing was assigned", () => {
    expect(drawerFor({ defaultModel: "anthropic/claude-sonnet-5" }, BOTH)).toBeUndefined();
  });
});

describe("with an override", () => {
  /** The case from the architecture: "Claude to reason, GPT to draw." */
  it("moves drawing to another vendor while the default stays put", () => {
    const drawer = drawerFor(
      { defaultModel: "anthropic/claude-sonnet-5", overrides: { image: "openai/gpt-image-1" } },
      BOTH
    );
    expect(drawer).toEqual({ vendor: "openai", apiKey: "o-key", model: "gpt-image-1" });
  });

  it("accepts a bare vendor, since the vendor is the part that carries meaning", () => {
    const drawer = drawerFor(
      { defaultModel: "anthropic/claude-sonnet-5", overrides: { image: "openai" } },
      BOTH
    );
    expect(drawer?.vendor).toBe("openai");
    expect(drawer?.model).toBeUndefined();
  });

  /**
   * A chat model named for an image capability resolves — GPT's *vendor* draws
   * — but `gpt-5.6` is not something the images endpoint accepts. Forwarding it
   * would turn a reasonable-looking setting into a 400 at the moment somebody
   * asks for a picture, which is the worst time to find out.
   */
  it("does not forward a chat model id to the image endpoint", () => {
    const drawer = drawerFor(
      { defaultModel: "anthropic/claude-sonnet-5", overrides: { image: "openai/gpt-5.6" } },
      BOTH
    );
    expect(drawer?.vendor).toBe("openai");
    expect(drawer?.model).toBeUndefined();
  });

  /**
   * The billing property, and the reason this is not a fallback chain.
   *
   * An admin who assigned drawing to OpenAI and has no OpenAI key has made a
   * mistake worth surfacing. Silently drawing on the Google key instead would
   * bill an account they did not choose and hide the misconfiguration for as
   * long as it kept working.
   */
  it("refuses rather than quietly billing a vendor the admin did not choose", () => {
    expect(
      drawerFor(
        { defaultModel: "google/gemini-3.5-flash", overrides: { image: "openai/gpt-image-1" } },
        keys({ google: "g-key" })
      )
    ).toBeUndefined();
  });

  /**
   * The defect this file's shared lookup exists to prevent, caught by running it.
   *
   * With two lookups, `NELL_MODEL_IMAGE=google` produced a drawer that drew
   * while `/models` reported *"I don't know the model 'google'"* and listed
   * image generation under what Nell cannot do. Settings contradicting the
   * running behaviour is worse than no settings: the person reads it, believes
   * it, and stops asking for the thing that would have worked.
   *
   * Asserted as the *agreement* rather than as either answer, because either
   * one alone can be right while the pair is wrong.
   */
  it("tells settings exactly what the picture tool will do", () => {
    for (const override of [
      "google",
      "openai/gpt-image-1",
      "anthropic/claude-sonnet-5",
      undefined,
    ]) {
      const assignment = {
        defaultModel: "anthropic/claude-sonnet-5",
        ...(override ? { overrides: { image: override } } : {}),
      };

      const settingsSaysItCan = capabilityReport(
        assignment,
        catalogLookup,
        new Set(["anthropic", "google", "openai"])
      ).can.includes("image");

      expect(Boolean(drawerFor(assignment, BOTH)), override ?? "no override").toBe(
        settingsSaysItCan
      );
    }
  });

  it("ignores a vendor nothing here knows how to call", () => {
    expect(
      drawerFor(
        { defaultModel: "anthropic/claude-sonnet-5", overrides: { image: "midjourney/v7" } },
        BOTH
      )
    ).toBeUndefined();
  });
});
