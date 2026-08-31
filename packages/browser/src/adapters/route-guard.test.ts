/**
 * The SSRF route guard, and the race that killed a running agent.
 *
 * The guard itself was right. What was wrong is that it could throw into a
 * promise nobody was awaiting: `allow` resolves DNS, which is slow, and in that
 * window the page can navigate away or the route be settled another way — after
 * which `route.continue()` throws **"Route is already handled!"**. Inside a
 * Playwright route handler that becomes an unhandled rejection, and Node ends
 * the process.
 *
 * It happened on an ordinary request — *"book me a romantic movie near UC
 * Berkeley"* — and what the user saw was the bot going silent mid-task.
 *
 * Two properties are asserted here and the second is the security one: the
 * handler never throws, and a check that could not be completed **fails
 * closed**. "We could not decide" and "it is allowed" are different answers.
 */

import { describe, expect, it } from "vitest";
import { guardForTest } from "./local-machine.js";

/** A route that records what was done to it, and can be made to misbehave. */
function route(url: string, options: { alreadyHandled?: boolean } = {}) {
  const did: string[] = [];
  return {
    did,
    request: () => ({ url: () => url }),
    continue: async () => {
      if (options.alreadyHandled) throw new Error("Route is already handled!");
      did.push("continue");
    },
    abort: async (reason?: string) => {
      if (options.alreadyHandled) throw new Error("Route is already handled!");
      did.push(`abort:${reason ?? ""}`);
    },
  };
}

const allowAll = async () => true;
const allowNone = async () => false;

describe("deciding", () => {
  it("lets a permitted request through", async () => {
    const r = route("https://example.com/x");
    await guardForTest(allowAll)(r as never);
    expect(r.did).toEqual(["continue"]);
  });

  it("aborts one the check refuses", async () => {
    const r = route("http://169.254.169.254/latest/meta-data/");
    await guardForTest(allowNone)(r as never);
    expect(r.did).toEqual(["abort:blockedbyclient"]);
  });
});

describe("the race that ended the process", () => {
  /**
   * The exact failure. The route was settled while DNS was resolving, so the
   * decision arrived too late to apply — which is ordinary, and was fatal.
   */
  it("does not throw when the route has already been handled", async () => {
    const r = route("https://example.com/x", { alreadyHandled: true });
    await expect(guardForTest(allowAll)(r as never)).resolves.toBeUndefined();
    expect(r.did).toEqual([]);
  });

  it("does not throw when an aborted route has already been handled", async () => {
    const r = route("http://10.0.0.1/", { alreadyHandled: true });
    await expect(guardForTest(allowNone)(r as never)).resolves.toBeUndefined();
  });
});

describe("failing closed", () => {
  /**
   * The security half. A DNS lookup that throws must not be read as consent —
   * an undecidable request is refused, and the alternative would turn every
   * resolver hiccup into a hole in the guard.
   */
  it("refuses a request whose check could not be completed", async () => {
    const r = route("https://unresolvable.example/x");
    await guardForTest(async () => {
      throw new Error("EAI_AGAIN");
    })(r as never);

    expect(r.did).toEqual(["abort:blockedbyclient"]);
  });
});
