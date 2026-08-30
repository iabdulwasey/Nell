/**
 * One browser, one driver at a time.
 *
 * Tasks run concurrently now. What makes that safe is not the cap on how many —
 * it is this, because the browser session carries **taint** (which fields have
 * had a credential typed into them) and **spend approvals**, both held per
 * session by the executor. Two tasks sharing one session would share both: an
 * approval granted for one task's £42 booking would be sitting ready when the
 * other reached a payment page.
 *
 * So the assertions worth having are about exclusion and about not stranding
 * the queue, and both are the kind of thing that looks fine until two things
 * actually overlap.
 */

import { afterEach, describe, expect, it } from "vitest";
import { resetMachineQueues, withMachine } from "./machine-lock.js";

const WORKSPACE = "personal:lock-test";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetMachineQueues();
});

describe("holding the machine", () => {
  it("lets only one in at a time", async () => {
    const order: string[] = [];
    let inside = 0;
    let most = 0;

    const work = (name: string) =>
      withMachine(WORKSPACE, async () => {
        inside += 1;
        most = Math.max(most, inside);
        order.push(`${name}:in`);
        await settle();
        order.push(`${name}:out`);
        inside -= 1;
      });

    await Promise.all([work("a"), work("b"), work("c")]);

    // Never two at once — the property the taint machine depends on.
    expect(most).toBe(1);
    // And each one finished before the next began, rather than interleaving.
    expect(order).toEqual(["a:in", "a:out", "b:in", "b:out", "c:in", "c:out"]);
  });

  /**
   * A browse step failing is ordinary — a page times out, a site refuses. If
   * the lock were held by a rejection, one such failure would strand every task
   * behind it for the life of the process, and the symptom would be an agent
   * that silently stops using its browser.
   */
  it("releases when the work throws, so nothing is stranded", async () => {
    const failed = withMachine(WORKSPACE, () => Promise.reject(new Error("the page died")));
    await expect(failed).rejects.toThrow("the page died");

    await expect(withMachine(WORKSPACE, () => Promise.resolve("after"))).resolves.toBe("after");
  });

  /**
   * The subtle one: a waiter must not inherit the failure it waited behind.
   *
   * The queue is a promise chain, and chaining onto a rejected promise hands
   * that rejection to everyone downstream — one task's dead page becoming every
   * later task's dead page, reported against work that never ran.
   */
  it("does not pass one task's failure to the next", async () => {
    const results: string[] = [];

    const first = withMachine(WORKSPACE, async () => {
      await settle();
      throw new Error("first failed");
    }).catch(() => results.push("first: failed"));

    const second = withMachine(WORKSPACE, async () => {
      await settle();
      results.push("second: ran");
      return "ok";
    });

    await first;
    await expect(second).resolves.toBe("ok");
    expect(results).toEqual(["first: failed", "second: ran"]);
  });

  /** Two workspaces share nothing — one person's booking must not queue behind another's. */
  it("queues per workspace rather than globally", async () => {
    let bothInside = false;
    let inA = false;

    const a = withMachine("workspace-a", async () => {
      inA = true;
      await settle();
      inA = false;
    });
    const b = withMachine("workspace-b", async () => {
      if (inA) bothInside = true;
      await settle();
    });

    await Promise.all([a, b]);
    expect(bothInside).toBe(true);
  });

  it("hands back what the work returned", async () => {
    expect(await withMachine(WORKSPACE, () => Promise.resolve(42))).toBe(42);
  });
});
