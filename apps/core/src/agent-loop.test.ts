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

  it("gives up once the page refuses everything", async () => {
    const { executor: exec, attempts } = executor(Number.POSITIVE_INFINITY);

    const outcome = await runLoop(
      { provider, executor: exec, model: model(), modelId: "m" },
      { scope, sessionId: "s", objective: "click the thing" }
    );

    expect(outcome.ok).toBe(false);
    expect(attempts()).toBe(MAX_ACTION_FAILURES);
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
