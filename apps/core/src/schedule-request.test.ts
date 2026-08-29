import type { ModelProvider } from "@nell/agent";
import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  looksRecurring,
  nextOccurrence,
  parseScheduleRequest,
} from "./schedule-request.js";

/** A model that returns whatever it is handed. */
function stub(value: unknown): ModelProvider {
  return {
    name: "stub",
    complete: async () => ({ ok: true, value, usage: { inputTokens: 0, outputTokens: 0 } }),
  } as unknown as ModelProvider;
}

const failing: ModelProvider = {
  name: "stub",
  complete: async () => ({ ok: false, reason: "down", retryable: true }),
} as unknown as ModelProvider;

describe("spotting a recurring request", () => {
  /**
   * The exact message that got missed, plus the spellings around it.
   *
   * Every test here originally used "every day" with a space, which is why the
   * gap survived: `\bevery\b` cannot match inside "everyday", and nothing in
   * the suite ever wrote it the common way.
   */
  it("recognises 'everyday' written as one word", () => {
    expect(
      looksRecurring(
        "Set an alert for 6 am everyday to scan the latest tech/ai news and send them to me"
      )
    ).toBe(true);
    expect(looksRecurring("everyday at 7 give me the weather")).toBe(true);
  });

  /** People ask for a standing instruction without ever saying a cadence word. */
  it("recognises the language of a standing instruction", () => {
    for (const text of [
      "set an alert for 6am tech news",
      "remind me at 9 to check the inbox",
      "notify me when you have the results each morning",
    ]) {
      expect(looksRecurring(text), text).toBe(true);
    }
  });

  it("recognises the ways people ask for something repeated", () => {
    for (const text of [
      "every morning at 6 send me the AI news",
      "each day at 9 check my inbox",
      "daily briefing please",
      "scan hourly and tell me",
      "from now on tell me the weather at 7",
    ]) {
      expect(looksRecurring(text), text).toBe(true);
    }
  });

  it("leaves one-off requests alone", () => {
    for (const text of [
      "find me a flight to Delhi",
      "what is the latest AI news",
      "book a table for two tomorrow",
    ]) {
      expect(looksRecurring(text), text).toBe(false);
    }
  });

  /**
   * "Every" is doing different work in "every morning" and "every time you
   * finish". Only the first is about a clock, and treating the second as a
   * schedule would set up a daily task out of an instruction about how to
   * behave during one.
   */
  it("does not mistake 'every time' for a schedule", () => {
    expect(looksRecurring("every time you finish, tell me what you did")).toBe(false);
    expect(looksRecurring("check everything on the page")).toBe(false);
  });
});

describe("when the first run lands", () => {
  const nineAm = new Date(2026, 7, 29, 9, 0, 0).getTime();

  /**
   * The obvious bug: setting up a 6am scan at 9am, and having it fire at once
   * because 6am today is in the past. It then texts you at 9am insisting it is
   * your morning briefing.
   */
  it("waits until tomorrow when today's time has passed", () => {
    const at = new Date(nextOccurrence(6, 0, nineAm));
    expect(at.getDate()).toBe(30);
    expect(at.getHours()).toBe(6);
  });

  it("uses today when the time is still ahead", () => {
    const at = new Date(nextOccurrence(18, 30, nineAm));
    expect(at.getDate()).toBe(29);
    expect(at.getHours()).toBe(18);
    expect(at.getMinutes()).toBe(30);
  });

  /** Exactly now counts as passed — otherwise it fires while being created. */
  it("treats the current minute as gone", () => {
    expect(nextOccurrence(9, 0, nineAm)).toBeGreaterThan(nineAm);
  });
});

describe("extracting the schedule", () => {
  const now = new Date(2026, 7, 29, 9, 0, 0).getTime();

  it("pulls out cadence, time and the task itself", async () => {
    const request = await parseScheduleRequest("every morning at 6 send me the AI news", {
      provider: stub({
        recurring: true,
        everyMinutes: 1440,
        atHour: 6,
        atMinute: 0,
        label: "AI news scan",
        task: "Find today's AI and tech news and summarise the headlines.",
      }),
      model: "m",
      now,
    });

    expect(request?.everyMinutes).toBe(1440);
    expect(request?.task).toContain("AI and tech news");
    expect(new Date(request?.firstRunAt ?? 0).getHours()).toBe(6);
  });

  it("never asks the model about a message that is not recurring", async () => {
    let asked = false;
    const watching: ModelProvider = {
      name: "stub",
      complete: async () => {
        asked = true;
        return { ok: true, value: {}, usage: { inputTokens: 0, outputTokens: 0 } };
      },
    } as unknown as ModelProvider;

    await parseScheduleRequest("find me a flight", { provider: watching, model: "m", now });
    expect(asked).toBe(false);
  });

  /**
   * A model that stutters over "every morning" should leave the message to be
   * treated as an ordinary task — which still does the useful thing once,
   * rather than failing outright.
   */
  it("gives up quietly when the model cannot answer", async () => {
    expect(
      await parseScheduleRequest("every morning at 6 send news", {
        provider: failing,
        model: "m",
        now,
      })
    ).toBeUndefined();
  });

  it("declines when the model says it is not recurring after all", async () => {
    expect(
      await parseScheduleRequest("every detail of the page please", {
        provider: stub({ recurring: false, task: "read the page" }),
        model: "m",
        now,
      })
    ).toBeUndefined();
  });

  /**
   * A model asked for "every few minutes" will say 1 and bill accordingly.
   * Anything that tight is a monitor with a cheap pre-check, not a task loop.
   */
  it("refuses a cadence tighter than the floor", async () => {
    const request = await parseScheduleRequest("every minute check the page", {
      provider: stub({
        recurring: true,
        everyMinutes: 1,
        atHour: 9,
        atMinute: 0,
        label: "x",
        task: "check",
      }),
      model: "m",
      now,
    });
    // The value is rejected and the default stands; it is never honoured.
    expect(request?.everyMinutes).not.toBe(1);
  });
});

describe("the confirmation", () => {
  it("says what was understood, so a wrong reading is visible", () => {
    const text = describeSchedule({
      everyMinutes: 1440,
      firstRunAt: new Date(2026, 7, 30, 6, 0, 0).getTime(),
      label: "AI news",
      task: "Find today's AI news.",
    });

    expect(text).toContain("every day");
    expect(text).toContain("Find today's AI news.");
  });

  it("describes hours and multi-day gaps in their own terms", () => {
    const base = { firstRunAt: Date.now(), label: "x", task: "y" };
    expect(describeSchedule({ ...base, everyMinutes: 60 })).toContain("every hour");
    expect(describeSchedule({ ...base, everyMinutes: 180 })).toContain("every 3 hours");
    expect(describeSchedule({ ...base, everyMinutes: 2880 })).toContain("every 2 days");
    expect(describeSchedule({ ...base, everyMinutes: 90 })).toContain("every 90 minutes");
  });
});
