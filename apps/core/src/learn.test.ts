/**
 * Noticing things about somebody.
 *
 * Nell renders `USER.md` and `MEMORY.md` and had almost nothing filling them:
 * the running agent learned exactly one fact on its own — where the user lives —
 * and `addRule`, which writes the standing rules `USER.md` is made of, was
 * called by nothing but tests. Everything else needed the person to type
 * `/remember` at it.
 *
 * The tests that matter most are the negatives. A profile that grows on every
 * turn is one nobody can read and every prompt has to carry, and the difference
 * between a fact and a request is the whole distinction: *"I never fly before
 * 9am"* is durable, *"book me a flight Friday"* is a task.
 */

import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@nell/agent";
import {
  describeLearned,
  learnFrom,
  MAX_PER_MESSAGE,
  mightSaySomethingAboutThem,
} from "./learn.js";

const answering = (value: unknown): ModelProvider =>
  ({
    name: "fake",
    complete: async () => ({ ok: true, value, usage: { inputTokens: 0, outputTokens: 0 } }),
  }) as unknown as ModelProvider;

const failing = {
  name: "fake",
  complete: async () => ({ ok: false, reason: "down" }),
} as unknown as ModelProvider;

const opts = (provider: ModelProvider) => ({ provider, model: "m" });

describe("is this message even about them", () => {
  it("catches first-person statements of habit and constraint", () => {
    for (const said of [
      "I never fly before 9am",
      "I'm vegetarian",
      "my usual seat is the aisle",
      "remember that I hate early starts",
      "from now on always ask before spending over £50",
      "I'm allergic to shellfish",
    ]) {
      expect(mightSaySomethingAboutThem(said), said).toBe(true);
    }
  });

  /**
   * The gate is a cost control, not a correctness one — but it must not spend a
   * model call on every "ok", which is most of what anybody types.
   */
  it("ignores ordinary traffic", () => {
    for (const said of ["ok", "thanks", "book a table for Friday", "what's the weather"]) {
      expect(mightSaySomethingAboutThem(said), said).toBe(false);
    }
  });
});

describe("what it keeps", () => {
  it("stores a durable fact with a stable key", async () => {
    const learned = await learnFrom(
      "I always take the aisle seat",
      opts(
        answering({
          preferences: [{ key: "travel.seat", value: "aisle", category: "travel" }],
          rules: [],
        })
      )
    );

    expect(learned?.preferences[0]).toEqual({
      // Stable, so restating it later replaces the fact rather than adding a
      // second copy that contradicts the first.
      key: "travel.seat",
      value: "aisle",
      category: "travel",
    });
  });

  it("stores a standing rule as a rule, not a fact", async () => {
    const learned = await learnFrom(
      "never book anything before 9am",
      opts(
        answering({
          preferences: [],
          rules: [{ kind: "never", rule: "Book anything before 9am" }],
        })
      )
    );
    expect(learned?.rules[0]?.kind).toBe("never");
  });

  /**
   * A model asked what it noticed will happily produce nine facts from one
   * sentence. A profile growing nine rows a turn is unreadable and every prompt
   * has to carry it; anything genuinely important gets said again.
   */
  it("takes only a few things from one message", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      key: `k${String(index)}`,
      value: "v",
      category: "other" as const,
    }));
    const learned = await learnFrom(
      "I prefer everything",
      opts(answering({ preferences: many, rules: [] }))
    );
    expect(learned?.preferences).toHaveLength(MAX_PER_MESSAGE);
  });
});

describe("what it must not do", () => {
  it("keeps nothing when the model finds nothing", async () => {
    expect(
      await learnFrom(
        "I prefer nothing in particular",
        opts(answering({ preferences: [], rules: [] }))
      )
    ).toBeUndefined();
  });

  /**
   * A bonus on top of an answer the person already has. A model that stutters
   * must not turn a delivered answer into a failed task.
   */
  it("gives up quietly when the model is unavailable", async () => {
    expect(await learnFrom("I always fly Emirates", opts(failing))).toBeUndefined();
  });

  it("keeps nothing from a reply it cannot read", async () => {
    expect(
      await learnFrom("I always fly Emirates", opts(answering({ nonsense: true })))
    ).toBeUndefined();
  });

  /**
   * The category is a closed set, and an invented one would fail the write at
   * the far end rather than here — where the failure is silent and the fact is
   * simply lost.
   */
  it("refuses a category that is not one of ours", async () => {
    expect(
      await learnFrom(
        "I always fly Emirates",
        opts(
          answering({
            preferences: [{ key: "travel.airline", value: "Emirates", category: "aviation" }],
            rules: [],
          })
        )
      )
    ).toBeUndefined();
  });
});

describe("telling them", () => {
  /**
   * Said out loud, briefly, and that is a design decision. A profile that
   * changes without a word is one somebody discovers by being surprised months
   * later — the exact shape of the competitor's own privacy scandal.
   */
  it("says what was noted, so it can be corrected while they are still here", () => {
    const said = describeLearned({
      preferences: [{ key: "travel.seat", value: "aisle seat", category: "travel" }],
      rules: [{ kind: "never", rule: "Book before 9am" }],
    });
    expect(said).toContain("aisle seat");
    expect(said).toContain("Book before 9am");
  });

  it("says nothing when nothing was learned", () => {
    expect(describeLearned({ preferences: [], rules: [] })).toBe("");
  });
});
