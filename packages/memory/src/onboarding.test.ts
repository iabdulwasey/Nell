import { describe, expect, it } from "vitest";
import {
  greeting,
  isQuestion,
  memoryFor,
  suggestFrom,
  MAX_SUGGESTIONS,
  MIN_OCCURRENCES,
  type OnboardingSignal,
} from "./index.js";

const NOW = 1_700_000_000_000;

function signal(overrides: Partial<OnboardingSignal> = {}): OnboardingSignal {
  return { kind: "past-task", detail: "book a table", at: NOW, occurrences: 3, ...overrides };
}

describe("nothing is looked up", () => {
  /**
   * The incumbent researches its user at signup and people described it as
   * unsettling rather than impressive, which is the correct reaction to being
   * investigated by a service you just signed up to.
   */
  it("derives suggestions only from what the user handed over", () => {
    const suggestions = suggestFrom(
      [
        signal({ kind: "connected-account", detail: "Gmail", occurrences: 1 }),
        signal({ kind: "past-task", detail: "book a table" }),
      ],
      NOW
    );

    for (const suggestion of suggestions) {
      expect(["connected-account", "past-task", "stated-in-passing"]).toContain(suggestion.source);
    }
  });

  it("says plainly that it has not looked them up", () => {
    const said = greeting();
    expect(said).toContain("have not looked you up");
    expect(said).toContain("will not");
  });

  // A new assistant that opens by listing capabilities invites the user to test
  // the most ambitious one first.
  it("says what it will ask permission for, not only what it can do", () => {
    expect(greeting()).toContain("ask before I spend money or message anyone");
    expect(greeting()).toContain("every time, not just the first");
  });
});

describe("asking, not concluding", () => {
  /**
   * "I've noted that you prefer aisle seats" is a system that decided something
   * about a person without asking, which is how a memory fills with confident
   * nonsense the user then has to find and delete.
   */
  it("phrases every suggestion as a question", () => {
    const suggestions = suggestFrom(
      [
        signal({ kind: "connected-account", detail: "Gmail" }),
        signal({ kind: "past-task", detail: "book a table" }),
        signal({ kind: "stated-in-passing", detail: "aisle seat" }),
      ],
      NOW
    );

    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) expect(isQuestion(suggestion)).toBe(true);
  });

  // The difference between asking and asserting erodes one careless edit at a
  // time — someone shortens a string, the question mark goes.
  it("can tell a question from an assertion", () => {
    const [suggestion] = suggestFrom([signal()], NOW);
    expect(isQuestion(suggestion!)).toBe(true);
    expect(isQuestion({ ...suggestion!, question: "I have noted this." })).toBe(false);
  });

  it("says why it is asking", () => {
    const [suggestion] = suggestFrom([signal({ occurrences: 4 })], NOW);
    expect(suggestion?.because).toContain("4 times");
  });
});

describe("not pestering", () => {
  /**
   * Once is an event, not a preference. Asking after a single flight produces an
   * assistant whose questions people learn to dismiss unread — after which the
   * useful one goes unread too.
   */
  it("waits for something to recur", () => {
    expect(suggestFrom([signal({ occurrences: MIN_OCCURRENCES - 1 })], NOW)).toEqual([]);
    expect(suggestFrom([signal({ occurrences: MIN_OCCURRENCES })], NOW).length).toBe(1);
  });

  // Connecting an account is itself a deliberate act, so once is enough.
  it("treats connecting an account as enough on its own", () => {
    expect(
      suggestFrom([signal({ kind: "connected-account", detail: "Gmail", occurrences: 1 })], NOW)
    ).toHaveLength(1);
  });

  it("asks a few things at most", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      signal({ detail: `task ${String(i)}`, at: NOW - i })
    );
    expect(suggestFrom(many, NOW)).toHaveLength(MAX_SUGGESTIONS);
  });

  // What someone did this week is a better guess than what they did in their
  // first hour.
  it("prefers what happened recently", () => {
    const suggestions = suggestFrom(
      [
        signal({ detail: "old thing", at: NOW - 1_000_000 }),
        signal({ detail: "recent thing", at: NOW }),
      ],
      NOW
    );
    expect(suggestions[0]?.wouldRemember).toContain("recent thing");
  });
});

describe("what gets written down", () => {
  it("remembers what they agreed to", () => {
    const [suggestion] = suggestFrom([signal()], NOW);
    expect(memoryFor(suggestion!, { suggestionId: suggestion!.id, accepted: true })).toBe(
      suggestion!.wouldRemember
    );
  });

  /**
   * Recording "does not want X" from a single dismissal turns "not now" into a
   * permanent belief, and the user has no idea it happened.
   */
  it("writes nothing at all when they say no", () => {
    const [suggestion] = suggestFrom([signal()], NOW);
    expect(
      memoryFor(suggestion!, { suggestionId: suggestion!.id, accepted: false })
    ).toBeUndefined();
  });

  it("ignores an answer to a different question", () => {
    const [suggestion] = suggestFrom([signal()], NOW);
    expect(
      memoryFor(suggestion!, { suggestionId: "something-else", accepted: true })
    ).toBeUndefined();
  });
});
