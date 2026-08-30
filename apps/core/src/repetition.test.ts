/**
 * Doing the same thing again, and noticing.
 *
 * Every case here is drawn from the run that made this necessary: a cinema
 * booking that clicked one "Proceed" button 41 times and drove a seat selection
 * from 2 up to 10 while believing it was reducing it.
 *
 * The negatives carry as much weight as the positives. A detector that reports
 * ordinary work as a rut is a detector somebody switches off, and legitimately
 * repeating an action a few times — a second click, a scroll through a long list
 * — is normal.
 */

import { describe, expect, it } from "vitest";
import type { PageSnapshot } from "@nell/browser";
import {
  actionSignature,
  REPEATING_AFTER,
  REPEATING_LIMIT,
  RepeatWatch,
  repetitionWarning,
  turnSignature,
} from "./repetition.js";

const snapshot = (nodes: { ref: string; role: string; name?: string }[]): PageSnapshot => ({
  url: "https://cinema.example/seats",
  title: "Seats",
  nodes,
  truncated: false,
});

describe("what an action is aimed at", () => {
  /**
   * The case the whole file turns on. A ref is `<version>:e<n>` and the version
   * changes with every snapshot, so without resolving it against the page the 41
   * identical clicks carry 41 different signatures and read as 41 fresh ideas.
   */
  it("resolves a ref to what it actually points at, so two snapshots agree", () => {
    const first = actionSignature(
      { action: "click", target: { by: "ref", ref: "7:e12" } },
      snapshot([{ ref: "7:e12", role: "button", name: "Proceed" }])
    );
    const later = actionSignature(
      { action: "click", target: { by: "ref", ref: "31:e12" } },
      snapshot([{ ref: "31:e12", role: "button", name: "Proceed" }])
    );

    expect(first).toBe("click:button/proceed");
    expect(later).toBe(first);
  });

  it("keeps two different buttons apart", () => {
    const page = snapshot([
      { ref: "1:e1", role: "button", name: "Proceed" },
      { ref: "1:e2", role: "button", name: "Back" },
    ]);
    expect(actionSignature({ action: "click", target: { by: "ref", ref: "1:e1" } }, page)).not.toBe(
      actionSignature({ action: "click", target: { by: "ref", ref: "1:e2" } }, page)
    );
  });

  it("names a role target directly", () => {
    expect(
      actionSignature({ action: "click", target: { by: "role", role: "button", name: "Proceed" } })
    ).toBe("click:button/proceed");
  });

  it("treats navigation to one URL as its own identity", () => {
    expect(actionSignature({ action: "goto", url: "https://a.example" })).toBe(
      "goto:https://a.example"
    );
  });

  /**
   * A ref that is not on this page cannot be identified, and guessing would make
   * every unresolvable click look like the same click.
   */
  it("gives up rather than guessing at an unresolvable target", () => {
    expect(
      actionSignature({ action: "click", target: { by: "ref", ref: "9:e99" } }, snapshot([]))
    ).toBeUndefined();
  });

  it("refuses to compare a turn holding anything it cannot identify", () => {
    const page = snapshot([{ ref: "1:e1", role: "button", name: "Proceed" }]);
    expect(
      turnSignature(
        [
          { action: "click", target: { by: "ref", ref: "1:e1" } },
          { action: "click", target: { by: "ref", ref: "1:e9" } },
        ],
        page
      )
    ).toBeUndefined();
  });
});

describe("how long it has been doing it", () => {
  it("warns once it has become a rut, and not before", () => {
    const watch = new RepeatWatch();
    const seen = Array.from({ length: REPEATING_AFTER }, () => watch.saw("click:button/proceed"));

    expect(seen.slice(0, -1).some((entry) => entry.warn)).toBe(false);
    expect(seen.at(-1)?.warn).toBe(true);
  });

  /** A warning ignored twice is not a warning. */
  it("gives up once told and ignored", () => {
    const watch = new RepeatWatch();
    let last = watch.saw("click:button/proceed");
    for (let attempt = 1; attempt < REPEATING_LIMIT; attempt += 1) {
      last = watch.saw("click:button/proceed");
    }
    expect(last.giveUp).toBe(true);
  });

  /**
   * Consecutive, not cumulative. Coming back to an action later having done
   * something else between is ordinary work — a form filled in two passes, a
   * list clicked through — and counting it would flag normal behaviour.
   */
  it("forgives an action returned to after doing something else", () => {
    const watch = new RepeatWatch();
    watch.saw("click:button/proceed");
    watch.saw("click:button/proceed");
    watch.saw("click:link/seats");
    const back = watch.saw("click:button/proceed");
    expect(back.count).toBe(1);
    expect(back.warn).toBe(false);
  });

  it("does not count a turn it could not identify as a repeat", () => {
    const watch = new RepeatWatch();
    watch.saw("click:button/proceed");
    watch.saw(undefined);
    const after = watch.saw("click:button/proceed");
    expect(after.count).toBe(1);
  });

  it("starts afresh when told to", () => {
    const watch = new RepeatWatch();
    watch.saw("click:button/proceed");
    watch.saw("click:button/proceed");
    watch.reset();
    expect(watch.saw("click:button/proceed").count).toBe(1);
  });
});

describe("what it says", () => {
  /**
   * Specific, and it names the deed. "Something is wrong" bought two more
   * reworded attempts at the same click; the count and the action leave nowhere
   * to go except somewhere else.
   */
  it("names the action and the count", () => {
    const said = repetitionWarning("click:button/proceed", 4);
    expect(said).toContain("click:button/proceed");
    expect(said).toContain("4 times");
    expect(said).toContain("5th time");
  });
});
