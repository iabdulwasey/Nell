/**
 * Trimming throat-clearing without eating the answer.
 *
 * The cases that matter are the ones where it must do *nothing*. Trimming model
 * output is a knife: the upside is a tidier first line and the downside is a
 * deleted answer, and those are not the same size. So every pattern is anchored,
 * bounded, and required to leave content behind.
 */

import { describe, expect, it } from "vitest";
import { withoutThroatClearing } from "./opening.js";

describe("openings that say nothing", () => {
  /** Exactly what was observed, twice, after the prompt had asked twice not to. */
  it("removes the acknowledgement and the promise of an answer in one line", () => {
    expect(
      withoutThroatClearing(
        "Perfect! Based on today's weather conditions and the sun position at 5 PM, here's your answer:\n\n37.7544, -122.4477"
      )
    ).toBe("37.7544, -122.4477");
  });

  it("removes a bare acknowledgement", () => {
    expect(withoutThroatClearing("Got it.\n\nThe fog clears around four.")).toBe(
      "The fog clears around four."
    );
  });

  it("removes a restatement of the question", () => {
    expect(withoutThroatClearing("You asked about the fog in SF.\n\nIt burns off by two.")).toBe(
      "It burns off by two."
    );
  });

  it("removes an offer to help that is not help", () => {
    expect(withoutThroatClearing("Let me check that for you.\nIt's £42.")).toBe("It's £42.");
  });
});

describe("what it must not touch", () => {
  /**
   * The word is the same and the sentence is an answer. A blocklist on words
   * would take this; a pattern anchored to a *whole* short opening does not.
   */
  it("keeps a sentence that merely begins with one of those words", () => {
    const answer = "Perfect weather for it — the fog clears at four and the light holds until six.";
    expect(withoutThroatClearing(answer)).toBe(answer);
  });

  /**
   * The one that matters most. A short reply is brief, not evasive, and turning
   * it into silence is worse than the thing being fixed.
   */
  it("never leaves nothing behind", () => {
    expect(withoutThroatClearing("Got it.")).toBe("Got it.");
    expect(withoutThroatClearing("Sure!")).toBe("Sure!");
  });

  it("keeps an answer that opens with a real finding", () => {
    const answer = "Based on the tide table, low water is at 15:12 — go then.";
    expect(withoutThroatClearing(answer)).toBe(answer);
  });

  it("keeps a long opening even if it starts like filler", () => {
    const answer =
      "Based on four separate forecasts, the marine layer is pulling back to the coast and the wind will shear it into wisps rather than leaving a blanket over the city.";
    expect(withoutThroatClearing(answer)).toBe(answer);
  });

  it("leaves an ordinary answer alone", () => {
    const answer = "37.7544, -122.4477 — Twin Peaks, Christmas Tree Point.";
    expect(withoutThroatClearing(answer)).toBe(answer);
  });

  /** Bounded rather than looped, so it cannot chew through a list of short lines. */
  it("stops after a few passes rather than eating a short-sentence answer", () => {
    const answer = "Yes. No. Maybe. It depends on the tide.";
    expect(withoutThroatClearing(answer)).toBe(answer);
  });
});
