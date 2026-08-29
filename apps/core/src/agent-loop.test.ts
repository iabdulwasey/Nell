/**
 * The loop's recovery, which for a long time was only a comment.
 *
 * The code returned on the first driver exception under a note claiming the
 * recovery was "the next iteration takes a fresh snapshot" — and there was no
 * next iteration. One flaky click ended a task that was a single fresh look
 * from working, and the user got `locator.click: Timeout 30000ms exceeded`.
 */

import type { BrowserExecutor } from "@nell/aegis";
import type { ModelProvider } from "@nell/agent";
import type { BrowserProvider } from "@nell/browser";
import { accessScopeForUser } from "@nell/shared";
import { describe, expect, it } from "vitest";
import { MAX_ACTION_FAILURES, runLoop } from "./agent-loop.js";

const scope = accessScopeForUser("loop");

const provider = {
  snapshot: async () => ({
    // Varies each call, so the stuck detector never fires and only the
    // behaviour under test can end the loop.
    url: `https://example.com/${String(Math.round(performance.now() * 1000))}`,
    title: "t",
    nodes: [],
    text: "",
    truncated: false,
  }),
} as unknown as BrowserProvider;

/** Always proposes one click, and finishes on the turn the caller chooses. */
function model(finishAtStep = Number.POSITIVE_INFINITY): ModelProvider {
  let step = 0;
  return {
    name: "stub",
    complete: async () => {
      step += 1;
      const done = step >= finishAtStep;
      return {
        ok: true,
        value: {
          reasoning: `step ${String(step)}`,
          done,
          answer: done ? "the answer" : "",
          search: "",
          actions: done ? [] : [{ action: "click", target: { by: "text", text: "Go" } }],
        },
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  } as unknown as ModelProvider;
}

/** Throws for the first `failures` calls, then works. */
function executor(failures: number): { executor: BrowserExecutor; attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    executor: {
      execute: async () => {
        attempts += 1;
        if (attempts <= failures) {
          throw new Error("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting");
        }
        return { ok: true };
      },
    } as unknown as BrowserExecutor,
  };
}

describe("when a step fails on the page", () => {
  /**
   * The behaviour the comment always claimed. A page that refused an action is a
   * page that has moved, and looking again is the right response — not ending
   * the task.
   */
  it("looks again and carries on, instead of giving up", async () => {
    const { executor: exec, attempts } = executor(1);

    const outcome = await runLoop(
      { provider, executor: exec, model: model(4), modelId: "m" },
      { scope, sessionId: "s", objective: "click the thing" }
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    // It genuinely retried rather than skipping the action.
    expect(attempts()).toBeGreaterThan(1);
  });

  /**
   * A page that refuses everything is not a reason to stop — it is a reason to
   * look at it. A click that times out three times usually means the element is
   * not where the accessibility tree claims, which is exactly what a screenshot
   * settles. Ending here threw away the second sense at the moment it was most
   * likely to help.
   */
  it("escalates to looking rather than ending, once the page refuses everything", async () => {
    const { executor: exec, attempts } = executor(Number.POSITIVE_INFINITY);
    const notes: string[] = [];

    const outcome = await runLoop(
      { provider, executor: exec, model: model(), modelId: "m" },
      {
        scope,
        sessionId: "s",
        objective: "click the thing",
        onDiagnostic: (note) => notes.push(note),
      }
    );

    expect(notes.join(" ")).toContain("switching to vision");
    // It tried the structured path to exhaustion, then tried the other sense.
    expect(attempts()).toBeGreaterThan(MAX_ACTION_FAILURES);
    expect(outcome.ok).toBe(false);
  });

  /**
   * The bound that replaced the step count. A step limit asks "how much work is
   * reasonable" and answers with a number chosen in advance; the question that
   * matters is whether the task is getting anywhere. A real booking was cut off
   * one step from checkout by a ceiling that had been guessed.
   */
  it("stops when nothing has changed for long enough, not at a step count", async () => {
    /**
     * Time advances once per turn, in the provider — not once per `clock()`
     * call. The first version advanced on every read, and since the loop reads
     * the clock several times a turn the elapsed time was whatever the code
     * path happened to be, which is a test that measures its own implementation.
     */
    let now = 0;
    const frozen = {
      snapshot: async () => {
        /**
         * Three minutes a turn, so the stall lands before the vision escalation.
         *
         * On a slower page the escalation fires first and that is the intended
         * order — going nowhere is a reason to look before it is a reason to
         * stop. Here the point is the stall itself, so the turns are long enough
         * to reach it while the unchanged counter is still short of its own
         * threshold.
         */
        now += 3 * 60_000;
        // Identical every time, so no turn ever counts as progress.
        return {
          url: "https://example.com/frozen",
          title: "t",
          nodes: [],
          text: "",
          truncated: false,
        };
      },
    } as unknown as BrowserProvider;

    const outcome = await runLoop(
      {
        provider: frozen,
        executor: executor(0).executor,
        model: model(),
        modelId: "m",
        clock: () => now,
      },
      { scope, sessionId: "s", objective: "wait forever", stallMs: 5 * 60_000 }
    );

    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.stuck).toBe(true);
    expect(outcome.reason).toContain("without getting anywhere");
    // Far fewer than the hard cap: it was time that ended this, not a counter.
    expect(outcome.steps).toBeLessThan(20);
  });

  /** And the other half: a task that keeps moving is not cut off. */
  it("keeps going while the page is changing", async () => {
    let now = 0;
    const moving = {
      snapshot: async () => {
        now += 60_000;
        return {
          // Different every turn, so every turn is progress.
          url: `https://example.com/${String(now)}`,
          title: "t",
          nodes: [],
          text: "",
          truncated: false,
        };
      },
    } as unknown as BrowserProvider;

    const outcome = await runLoop(
      {
        provider: moving,
        executor: executor(0).executor,
        model: model(15),
        modelId: "m",
        clock: () => now,
      },
      { scope, sessionId: "s", objective: "a long booking", stallMs: 5 * 60_000 }
    );

    // Fifteen turns, well past the old ceiling of twelve, because every one of
    // them changed the page.
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(outcome.steps).toBeGreaterThan(12);
  });

  /**
   * Changing is not progressing.
   *
   * Watched live: the agent bounced between a cinema's home page and its search
   * results for nearly three minutes — home, search, home, search — and every
   * turn "changed the page", so nothing ever looked stuck. It was moving and
   * getting nowhere, which is what a loop is.
   */
  it("treats going round in circles as getting nowhere", async () => {
    let now = 0;
    let turn = 0;
    const oscillating = {
      snapshot: async () => {
        now += 60_000;
        turn += 1;
        // Two pages, alternating: never the same twice in a row, never new.
        return {
          url: turn % 2 === 0 ? "https://example.com/a" : "https://example.com/b",
          title: "t",
          nodes: [],
          text: "",
          truncated: false,
        };
      },
    } as unknown as BrowserProvider;

    const outcome = await runLoop(
      {
        provider: oscillating,
        executor: executor(0).executor,
        model: model(),
        modelId: "m",
        clock: () => now,
      },
      { scope, sessionId: "s", objective: "go in circles", stallMs: 5 * 60_000 }
    );

    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.stuck).toBe(true);
    // Stopped on time, not on a step count — and long before the hard cap.
    expect(outcome.steps).toBeLessThan(12);
  });

  /** The complaint that started this. */
  it("never puts the driver's words in front of the user", async () => {
    const { executor: exec } = executor(Number.POSITIVE_INFINITY);

    const outcome = await runLoop(
      { provider, executor: exec, model: model(), modelId: "m" },
      { scope, sessionId: "s", objective: "click the thing" }
    );

    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.reason).not.toContain("locator.click");
    expect(outcome.reason).not.toContain("Timeout 30000ms");
    // Kept, where it is useful.
    expect(outcome.detail).toContain("Timeout 30000ms");
  });

  /**
   * Consecutive, not cumulative. A task should not carry a grudge from step two
   * into step nine — pages are flaky in bursts.
   */
  it("forgets earlier failures once a step works", async () => {
    let attempts = 0;
    // Fails on attempts 1, 3 and 5 — three failures, never three in a row.
    const flaky = {
      execute: async () => {
        attempts += 1;
        if (attempts % 2 === 1) throw new Error("locator.click: Timeout 30000ms exceeded.");
        return { ok: true };
      },
    } as unknown as BrowserExecutor;

    const outcome = await runLoop(
      { provider, executor: flaky, model: model(8), modelId: "m" },
      { scope, sessionId: "s", objective: "click the thing" }
    );

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });

  /**
   * A provider error carries the API's own words — an error body, a rate-limit
   * notice. Useful in a terminal, meaningless in a chat message.
   */
  it("does not forward the model provider's error text either", async () => {
    const failing = {
      name: "stub",
      complete: async () => ({
        ok: false,
        reason: '429 {"type":"error","error":{"message":"rate_limit_error"}}',
        retryable: true,
      }),
    } as unknown as ModelProvider;

    const outcome = await runLoop(
      { provider, executor: executor(0).executor, model: failing, modelId: "m" },
      { scope, sessionId: "s", objective: "anything" }
    );

    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.reason).not.toContain("rate_limit_error");
    expect(outcome.reason).not.toContain("{");
    expect(outcome.reason.toLowerCase()).toContain("busy");
  });
});
