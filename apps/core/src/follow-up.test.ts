/**
 * Deciding to look again, and deciding to stay quiet.
 *
 * The gate is what these tests are mostly about, because it is what stops this
 * being a bill on every answer. Two conditions have to hold together: the answer
 * names a **future moment**, and it depends on something that **moves on its
 * own**. Either alone is not enough, and the pairs that fail are more
 * interesting than the ones that pass — "what time is sunset tonight" is about a
 * future moment and is settled, because the almanac will not revise itself.
 *
 * The other half is the verdict, where the default is silence. A follow-up that
 * arrives to say "still fine" is the notification that teaches somebody to stop
 * reading them, which costs them the one that mattered.
 */

import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@nell/agent";
import { couldGoStale, decideFollowUp, verdictOn } from "./follow-up.js";

const answering = (value: unknown): ModelProvider => ({
  name: "fake",
  complete: async () => ({ ok: true, value, usage: { inputTokens: 0, outputTokens: 0 } }) as never,
});

const failing: ModelProvider = {
  name: "fake",
  complete: async () => ({ ok: false, reason: "down" }) as never,
};

describe("could this answer go stale", () => {
  it("catches a recommendation about a moment that has not happened yet", () => {
    expect(
      couldGoStale(
        "where should I photograph Sutro Tower at 5pm",
        "Tank Hill, if the fog pushes inland — the forecast has wind at 10-20mph."
      )
    ).toBe(true);
  });

  /**
   * A future moment, and nothing that moves. The sunset time was computed from
   * an almanac and will be the same in four hours; going back to check would be
   * a message that could never carry news.
   */
  it("leaves alone a future moment that is already settled", () => {
    expect(couldGoStale("what time is sunset tonight", "Sunset is at 7:48 PM.")).toBe(false);
  });

  /** A moving condition, and no future moment: the question was about now. */
  it("leaves alone a question that was only ever about right now", () => {
    expect(couldGoStale("what is the weather", "It is 14°C and raining.")).toBe(false);
  });

  it("leaves alone arithmetic", () => {
    expect(couldGoStale("what is 15% of 847", "127.05, which is €137.21 at 1.08.")).toBe(false);
  });

  it("catches availability, which is the other thing that moves", () => {
    expect(
      couldGoStale("are there tickets for tonight", "Yes — 12 seats left in the stalls.")
    ).toBe(true);
  });
});

describe("deciding when to look again", () => {
  it("does not spend a model call on something that cannot go stale", async () => {
    let called = false;
    const provider: ModelProvider = {
      name: "fake",
      complete: async () => {
        called = true;
        return { ok: true, value: {} } as never;
      },
    };

    await decideFollowUp("what is 15% of 847", "127.05.", { provider, model: "m" });
    expect(called).toBe(false);
  });

  it("schedules the look before the person would act", async () => {
    const now = 1_700_000_000_000;
    const planned = await decideFollowUp(
      "where should I photograph Sutro Tower at 5pm",
      "Tank Hill, if the fog pushes inland. Wind is 10-20mph.",
      {
        provider: answering({
          worthChecking: true,
          minutesFromNow: 270,
          label: "Sutro fog check",
          recheck: "Check current fog and wind over San Francisco.",
        }),
        model: "m",
        now,
      }
    );

    expect(planned?.label).toBe("Sutro fog check");
    expect(planned?.runAt).toBe(now + 270 * 60_000);
    // Carried so the later message can correct specifics rather than restate.
    expect(planned?.original).toContain("Tank Hill");
  });

  /**
   * A model asked "when should I look again" will occasionally say 1, which
   * would fire before the person has finished reading the first answer.
   */
  it("refuses to fire before they have read the answer", async () => {
    const now = 1_700_000_000_000;
    const planned = await decideFollowUp("tickets for tonight", "12 seats left.", {
      provider: answering({
        worthChecking: true,
        minutesFromNow: 1,
        label: "x",
        recheck: "check seats",
      }),
      model: "m",
      now,
    });
    expect(planned?.runAt).toBe(now + 10 * 60_000);
  });

  it("takes the model's no for an answer", async () => {
    expect(
      await decideFollowUp("tickets for tonight", "12 seats left.", {
        provider: answering({ worthChecking: false, minutesFromNow: 60, label: "x", recheck: "y" }),
        model: "m",
      })
    ).toBeUndefined();
  });

  /**
   * A follow-up is a bonus on top of an answer the user already has. A model
   * that stutters over the decision must not turn a delivered answer into a
   * failed task.
   */
  it("gives up quietly when the model is unavailable", async () => {
    expect(
      await decideFollowUp("tickets for tonight", "12 seats left.", {
        provider: failing,
        model: "m",
      })
    ).toBeUndefined();
  });
});

describe("whether to say anything at all", () => {
  /** The property the whole feature turns on. */
  it("stays silent when the advice still stands", async () => {
    expect(
      await verdictOn("Shoot from Tank Hill at 5.", "Fog unchanged, wind 12mph.", {
        provider: answering({ stillStands: true, message: "Still fine!" }),
        model: "m",
      })
    ).toBeUndefined();
  });

  it("speaks when it has changed, correcting what was said", async () => {
    const message = await verdictOn(
      "Shoot from Tank Hill at 5. Try 1/15 if the fog is ripping.",
      "Wind now 24mph gusting, 8% cloud, clear at 5pm.",
      {
        provider: answering({
          stillStands: false,
          message: "Fog's a bust — skip the 1/15 exposures, handheld 1/500 instead.",
        }),
        model: "m",
      }
    );
    expect(message).toContain("skip the 1/15");
  });

  /** "It changed" with nothing to say is the same as nothing to say. */
  it("stays silent when it claims a change but writes nothing", async () => {
    expect(
      await verdictOn("a", "b", {
        provider: answering({ stillStands: false, message: "   " }),
        model: "m",
      })
    ).toBeUndefined();
  });

  it("stays silent when the model is unavailable", async () => {
    expect(await verdictOn("a", "b", { provider: failing, model: "m" })).toBeUndefined();
  });
});
