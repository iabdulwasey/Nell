/**
 * A task that waits for another.
 *
 * The queue released work on a **free slot** rather than on the thing it needed,
 * which cannot express "after that one". So "book me a flight" followed by "and
 * put it in my calendar" ran the two concurrently and the second found nothing
 * to add — a failure with no error in it, which is the kind this codebase keeps
 * finding.
 *
 * The property worth guarding is not that waiting works. It is that waiting
 * **does not block anything else**: a dependency that stalled the whole queue
 * would trade one silent failure for a louder one.
 */

import { describe, expect, it } from "vitest";
import { nextReady } from "./nell.js";

const running =
  (...ids: string[]) =>
  (taskId: string) =>
    ids.includes(taskId);

describe("choosing what to run next", () => {
  it("takes the first thing when nothing is waiting", () => {
    expect(nextReady([{}, {}], running())).toBe(0);
  });

  it("holds back work that needs a running task to finish", () => {
    expect(nextReady([{ waitsFor: "flight" }], running("flight"))).toBe(-1);
  });

  it("releases it once that task is gone", () => {
    expect(nextReady([{ waitsFor: "flight" }], running())).toBe(0);
  });

  /**
   * The property that matters. A booking takes minutes; a question asked while
   * it runs should not sit behind something waiting on it.
   */
  it("does not let a waiting item block an unrelated one behind it", () => {
    const queue = [{ waitsFor: "flight" }, {}];
    expect(nextReady(queue, running("flight"))).toBe(1);
  });

  it("keeps first-in-first-out when nothing is blocked", () => {
    const queue = [{}, { waitsFor: "done-already" }, {}];
    expect(nextReady(queue, running("something-else"))).toBe(0);
  });

  /**
   * A dependency that cannot be satisfied by waiting must not wait for ever.
   * A task that finished and one that never existed read identically here, and
   * both readings are right.
   */
  it("does not wait for ever on a task that will never run", () => {
    expect(nextReady([{ waitsFor: "never-existed" }], running("other"))).toBe(0);
  });

  it("reports nothing ready when everything is waiting", () => {
    const queue = [{ waitsFor: "a" }, { waitsFor: "b" }];
    expect(nextReady(queue, running("a", "b"))).toBe(-1);
  });
});
