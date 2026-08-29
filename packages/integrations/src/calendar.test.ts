import { describe, expect, it } from "vitest";
import {
  checkWrite,
  conflictsWith,
  describeTrigger,
  findFreeSlots,
  hourInZone,
  isFree,
  meetingTriggers,
  shiftByDays,
  wallClockIn,
  IMMINENT_MINUTES,
  MAX_EVENT_MS,
  PREP_LEAD_MINUTES,
  TRAVEL_LEAD_MINUTES,
  type CalendarEvent,
} from "./index.js";

const HOUR = 3_600_000;

/** Wednesday 3 September 2026, 09:00 UTC. */
const NOW = Date.UTC(2026, 8, 3, 9, 0);

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    title: "Standup",
    startsAt: NOW + HOUR,
    endsAt: NOW + 2 * HOUR,
    timeZone: "Europe/London",
    attendees: [],
    ...overrides,
  };
}

describe("conflicts", () => {
  it("finds an overlap and reports how much", () => {
    const clashes = conflictsWith([event()], { from: NOW + 90 * 60_000, to: NOW + 3 * HOUR });
    expect(clashes).toHaveLength(1);
    expect(clashes[0]?.overlapMs).toBe(30 * 60_000);
  });

  it("does not treat adjacency as an overlap", () => {
    expect(isFree([event()], { from: NOW + 2 * HOUR, to: NOW + 3 * HOUR })).toBe(true);
  });

  /**
   * Treating a declined invitation as busy is how an assistant refuses to book
   * anything on a day full of meetings someone else scheduled.
   */
  it("ignores meetings the user declined", () => {
    const declined = event({ response: "declined" });
    expect(isFree([declined], { from: NOW + HOUR, to: NOW + 2 * HOUR })).toBe(true);
  });

  it("still counts a tentative one, because the user might go", () => {
    const tentative = event({ response: "tentative" });
    expect(isFree([tentative], { from: NOW + HOUR, to: NOW + 2 * HOUR })).toBe(false);
  });

  // "Ada's birthday" occupies a day in the sense of appearing on it, not in the
  // sense of preventing lunch.
  it("ignores all-day events", () => {
    const birthday = event({ allDay: true, startsAt: NOW, endsAt: NOW + 24 * HOUR });
    expect(isFree([birthday], { from: NOW + HOUR, to: NOW + 2 * HOUR })).toBe(true);
  });

  it("orders clashes by how much they actually overlap", () => {
    const brush = event({ id: "brush", startsAt: NOW + 2 * HOUR - 60_000, endsAt: NOW + 3 * HOUR });
    const solid = event({ id: "solid", startsAt: NOW + HOUR, endsAt: NOW + 2 * HOUR });

    const clashes = conflictsWith([brush, solid], { from: NOW + HOUR, to: NOW + 2 * HOUR });
    expect(clashes[0]?.event.id).toBe("solid");
  });
});

describe("finding a time", () => {
  it("offers slots that are actually free", () => {
    const slots = findFreeSlots([event()], {
      window: { from: NOW, to: NOW + 8 * HOUR },
      durationMs: HOUR,
      timeZone: "Europe/London",
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(isFree([event()], slot)).toBe(true);
  });

  // Nobody wants a meeting at 14:07.
  it("lands on the half hour", () => {
    const slots = findFreeSlots([], {
      window: { from: NOW + 7 * 60_000, to: NOW + 8 * HOUR },
      durationMs: HOUR,
      timeZone: "Europe/London",
    });
    for (const slot of slots) expect(slot.from % (30 * 60_000)).toBe(0);
  });

  /**
   * A search that offers 3am has technically answered the question and
   * practically wasted everyone's time — and the hours are the user's, not UTC.
   */
  it("stays inside waking hours in the user's zone", () => {
    const slots = findFreeSlots([], {
      window: { from: NOW, to: NOW + 48 * HOUR },
      durationMs: HOUR,
      timeZone: "America/New_York",
      earliestHour: 9,
      latestHour: 17,
      limit: 20,
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const hour = hourInZone(slot.from, "America/New_York");
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(17);
    }
  });

  /**
   * The off-by-midnight bug this found: a slot from 23:30 to 00:30 has an end
   * hour of 0, and zero is less than five in the afternoon, so a cutoff check
   * on the end hour alone accepts it. That is how "how about half past eleven
   * tonight?" reaches a user.
   */
  it("never proposes a slot that crosses midnight", () => {
    const slots = findFreeSlots([], {
      window: { from: NOW, to: NOW + 72 * HOUR },
      durationMs: HOUR,
      timeZone: "America/New_York",
      earliestHour: 9,
      latestHour: 17,
      limit: 40,
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const startDay = wallClockIn(slot.from, "America/New_York").day;
      const endDay = wallClockIn(slot.to - 1, "America/New_York").day;
      expect(endDay).toBe(startDay);
    }
  });

  it("does not propose a slot that would run past the end of the day", () => {
    const slots = findFreeSlots([], {
      window: { from: NOW, to: NOW + 48 * HOUR },
      durationMs: 2 * HOUR,
      timeZone: "Europe/London",
      earliestHour: 9,
      latestHour: 17,
      limit: 20,
    });
    for (const slot of slots) {
      expect(hourInZone(slot.to - 1, "Europe/London")).toBeLessThan(17);
    }
  });

  it("returns nothing when the window is full", () => {
    const blocking = event({ startsAt: NOW, endsAt: NOW + 48 * HOUR });
    expect(
      findFreeSlots([blocking], {
        window: { from: NOW, to: NOW + 8 * HOUR },
        durationMs: HOUR,
        timeZone: "Europe/London",
      })
    ).toEqual([]);
  });
});

describe("time is not a number", () => {
  it("reads the wall clock in the right zone", () => {
    // 09:00 UTC in September is 10:00 in London (BST) and 05:00 in New York.
    expect(hourInZone(NOW, "Europe/London")).toBe(10);
    expect(hourInZone(NOW, "America/New_York")).toBe(5);
    expect(hourInZone(NOW, "UTC")).toBe(9);
  });

  it("decomposes an instant into local parts", () => {
    expect(wallClockIn(NOW, "Europe/London")).toMatchObject({
      year: 2026,
      month: 9,
      day: 3,
      hour: 10,
      minute: 0,
    });
  });

  /**
   * The bug this exists to prevent: moving a 09:00 standup across a
   * daylight-saving change with naive arithmetic produces 08:00 or 10:00. It
   * appears twice a year, affects one week, and is impossible to reproduce when
   * someone reports it in July.
   */
  it("keeps the wall clock when shifting across a clock change", () => {
    // Friday 23 October 2026, 09:00 London (BST). The UK moves to GMT on the
    // 25th, so a week later is 09:00 GMT — a different number of hours away.
    const before = Date.UTC(2026, 9, 23, 8, 0);
    const standup = event({ startsAt: before, endsAt: before + HOUR });

    const moved = shiftByDays(standup, 7);

    expect(hourInZone(moved.startsAt, "Europe/London")).toBe(9);
    // And it is NOT simply seven times twenty-four hours later.
    expect(moved.startsAt).not.toBe(before + 7 * 24 * HOUR);
  });

  it("keeps the wall clock for an ordinary shift too", () => {
    const moved = shiftByDays(event(), 1);
    expect(hourInZone(moved.startsAt, "Europe/London")).toBe(
      hourInZone(event().startsAt, "Europe/London")
    );
  });

  it("preserves the duration when moving", () => {
    const original = event({ endsAt: NOW + HOUR + 30 * 60_000 });
    const moved = shiftByDays(original, 3);
    expect(moved.endsAt - moved.startsAt).toBe(original.endsAt - original.startsAt);
  });

  it("shifts backwards as well as forwards", () => {
    const moved = shiftByDays(event(), -2);
    expect(moved.startsAt).toBeLessThan(event().startsAt);
    expect(hourInZone(moved.startsAt, "Europe/London")).toBe(11);
  });
});

describe("an event with attendees is a message", () => {
  const base = { existing: [], now: NOW } as const;

  /**
   * Creating it sends invitations from the user to other people, who cannot
   * tell it apart from the user writing to them. That meets the bar for sending
   * a message, not the bar for editing a private list.
   */
  it("refuses to invite people without approval", () => {
    const decision = checkWrite({
      ...base,
      event: event({ attendees: [{ email: "sam@example.com", optional: false }] }),
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("invites-others");
      expect(decision.message).toContain("sam@example.com");
      expect(decision.message).toContain("from you");
    }
  });

  it("allows a private event with no attendees", () => {
    expect(checkWrite({ ...base, event: event() }).ok).toBe(true);
  });

  it("proceeds once the invitation is approved", () => {
    expect(
      checkWrite({
        ...base,
        event: event({ attendees: [{ email: "sam@example.com", optional: false }] }),
        approvedInvites: true,
      }).ok
    ).toBe(true);
  });
});

describe("refusing nonsense before it reaches a calendar", () => {
  const base = { existing: [], now: NOW } as const;

  it("refuses an event that ends before it starts", () => {
    const decision = checkWrite({
      ...base,
      event: event({ startsAt: NOW + 2 * HOUR, endsAt: NOW + HOUR }),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("backwards");
  });

  it("refuses a time that has already passed", () => {
    const decision = checkWrite({ ...base, event: event({ startsAt: NOW - HOUR, endsAt: NOW }) });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("in-the-past");
  });

  // Longer than half a day is a misread time, not a meeting.
  it("refuses an implausibly long meeting", () => {
    const decision = checkWrite({
      ...base,
      event: event({ endsAt: NOW + MAX_EVENT_MS + 2 * HOUR }),
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("too-long");
  });

  it("allows a genuinely all-day event", () => {
    expect(
      checkWrite({
        ...base,
        event: event({ allDay: true, endsAt: NOW + 24 * HOUR }),
      }).ok
    ).toBe(true);
  });

  // An assistant that double-books is worse than no assistant.
  it("names the clash rather than refusing blankly", () => {
    const decision = checkWrite({
      event: event(),
      existing: [event({ id: "other", title: "Dentist" })],
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("conflicts");
      expect(decision.message).toContain("Dentist");
    }
  });

  it("books anyway once the user says so", () => {
    expect(
      checkWrite({
        event: event(),
        existing: [event({ id: "other", title: "Dentist" })],
        now: NOW,
        acceptedConflict: true,
      }).ok
    ).toBe(true);
  });
});

describe("proactive triggers", () => {
  /**
   * An assistant that announces every meeting is a notification the user turns
   * off, after which it cannot tell them the one thing that mattered.
   */
  it("stays quiet about a meeting that is hours away", () => {
    expect(meetingTriggers([event({ startsAt: NOW + 5 * HOUR })], NOW)).toEqual([]);
  });

  // Leaving takes longer than people allow for. This is the trigger that
  // actually saves someone something.
  it("fires early for somewhere to travel to", () => {
    const triggers = meetingTriggers(
      [event({ location: "Rossi, Soho", startsAt: NOW + (TRAVEL_LEAD_MINUTES - 5) * 60_000 })],
      NOW
    );
    expect(triggers[0]?.reason).toBe("needs-travel");
    expect(describeTrigger(triggers[0]!)).toContain("Rossi, Soho");
  });

  it("offers preparation for a meeting with several people", () => {
    const triggers = meetingTriggers(
      [
        event({
          attendees: [
            { email: "a@example.com", optional: false },
            { email: "b@example.com", optional: false },
          ],
          startsAt: NOW + (PREP_LEAD_MINUTES - 5) * 60_000,
        }),
      ],
      NOW
    );
    expect(triggers[0]?.reason).toBe("needs-preparation");
  });

  it("says something plain when a meeting is imminent", () => {
    const triggers = meetingTriggers(
      [event({ startsAt: NOW + (IMMINENT_MINUTES - 2) * 60_000 })],
      NOW
    );
    expect(triggers[0]?.reason).toBe("starting-soon");
    expect(describeTrigger(triggers[0]!)).toContain("Standup");
  });

  it("fires once per meeting, not once per rule", () => {
    const triggers = meetingTriggers(
      [
        event({
          location: "Somewhere",
          attendees: [
            { email: "a@example.com", optional: false },
            { email: "b@example.com", optional: false },
          ],
          startsAt: NOW + 5 * 60_000,
        }),
      ],
      NOW
    );
    expect(triggers).toHaveLength(1);
  });

  it("ignores meetings the user declined, and things already started", () => {
    expect(
      meetingTriggers(
        [
          event({ response: "declined", startsAt: NOW + 60_000 }),
          event({ id: "past", startsAt: NOW - HOUR }),
        ],
        NOW
      )
    ).toEqual([]);
  });

  it("puts the most urgent first", () => {
    const triggers = meetingTriggers(
      [
        event({ id: "later", startsAt: NOW + 9 * 60_000 }),
        event({ id: "sooner", startsAt: NOW + 2 * 60_000 }),
      ],
      NOW
    );
    expect(triggers[0]?.event.id).toBe("sooner");
  });
});
