/**
 * Calendar.
 *
 * Two things about calendars break agents that treat them as a list of rows.
 *
 * **A time is not a number.** "Three o'clock" means nothing without a zone, and
 * a calendar spans zones by nature: the user is in London, the restaurant is in
 * New York, the recurring standup was created in Berlin. Every instant here is
 * stored as UTC plus the IANA zone it was expressed in, because throwing the
 * zone away makes a class of bug that only appears twice a year and is
 * unfalsifiable when reported. When a user moves a weekly meeting across a
 * daylight-saving boundary they mean the *wall clock* stays put, not the
 * instant — so moving keeps the local time and recomputes the instant, which is
 * the opposite of what naive arithmetic does.
 *
 * **An event with attendees is not a calendar write. It is a message.** Creating
 * it sends invitations to other people, from the user, without them reviewing
 * the text. That is an outbound send wearing a calendar's clothes, and it is
 * gated as one — the same first-contact rule that governs email applies here,
 * because the recipient cannot tell the difference.
 *
 * The rest is ordinary care: check for conflicts before proposing a time, since
 * an assistant that double-books is worse than no assistant.
 */

import { z } from "zod";

export const attendeeSchema = z.object({
  email: z.string().email().max(320),
  /** Whether they must be there for the meeting to be worth holding. */
  optional: z.boolean().default(false),
});

export type Attendee = z.infer<typeof attendeeSchema>;

export interface CalendarEvent {
  readonly id: string;
  readonly title: string;
  /** UTC instant. The single source of truth for ordering and overlap. */
  readonly startsAt: number;
  readonly endsAt: number;
  /**
   * IANA zone the time was expressed in. Kept because "9am" is a fact about a
   * place, and a recurring event needs it to survive a clock change.
   */
  readonly timeZone: string;
  readonly attendees: readonly Attendee[];
  readonly location?: string;
  /** True for a day-long event, where a start instant is a formality. */
  readonly allDay?: boolean;
  /** Present when the user has said whether they are going. */
  readonly response?: "accepted" | "declined" | "tentative";
}

export interface CalendarWindow {
  readonly from: number;
  readonly to: number;
}

export interface CalendarProvider {
  readonly name: string;
  list(window: CalendarWindow): Promise<readonly CalendarEvent[]>;
  create(event: Omit<CalendarEvent, "id">): Promise<CalendarEvent>;
  move(eventId: string, startsAt: number, endsAt: number): Promise<CalendarEvent>;
  cancel(eventId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Conflicts                                                                   */
/* -------------------------------------------------------------------------- */

export interface Conflict {
  readonly event: CalendarEvent;
  /** Milliseconds of actual overlap, so a one-minute brush reads differently. */
  readonly overlapMs: number;
}

/**
 * Events that genuinely clash with a proposed slot.
 *
 * Declined events are not conflicts: the user said they are not going, and
 * treating a declined invitation as busy is how an assistant refuses to book
 * anything on a day full of meetings someone else scheduled.
 *
 * All-day events are not conflicts either. "Ada's birthday" occupies a day in
 * the sense of appearing on it, not in the sense of preventing lunch.
 */
export function conflictsWith(
  events: readonly CalendarEvent[],
  slot: CalendarWindow
): readonly Conflict[] {
  return events
    .filter((event) => event.response !== "declined" && event.allDay !== true)
    .map((event) => ({
      event,
      overlapMs: Math.min(event.endsAt, slot.to) - Math.max(event.startsAt, slot.from),
    }))
    .filter((conflict) => conflict.overlapMs > 0)
    .sort((a, b) => b.overlapMs - a.overlapMs);
}

/** Whether a slot is genuinely free. */
export function isFree(events: readonly CalendarEvent[], slot: CalendarWindow): boolean {
  return conflictsWith(events, slot).length === 0;
}

export interface SlotSearch {
  readonly window: CalendarWindow;
  readonly durationMs: number;
  /** Earliest hour of the day to propose, in the user's zone. */
  readonly earliestHour?: number;
  readonly latestHour?: number;
  readonly timeZone: string;
  readonly limit?: number;
}

const HOUR_MS = 3_600_000;

/**
 * Propose free slots.
 *
 * Steps on the half hour, because nobody wants a meeting at 14:07, and respects
 * waking hours in the *user's* zone rather than UTC — a search that offers 3am
 * has technically answered the question and practically wasted everyone's time.
 */
export function findFreeSlots(
  events: readonly CalendarEvent[],
  search: SlotSearch
): readonly CalendarWindow[] {
  const step = 30 * 60_000;
  const earliest = search.earliestHour ?? 9;
  const latest = search.latestHour ?? 18;
  const found: CalendarWindow[] = [];

  for (
    let start = ceilTo(search.window.from, step);
    start + search.durationMs <= search.window.to;
    start += step
  ) {
    const slot = { from: start, to: start + search.durationMs };
    if (!withinWakingHours(slot, search.timeZone, earliest, latest)) continue;
    if (!isFree(events, slot)) continue;

    found.push(slot);
    if (found.length >= (search.limit ?? 5)) break;
  }

  return found;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

/**
 * Whether a slot sits inside the working day, in the user's own zone.
 *
 * The day-boundary check is the part that is easy to miss and embarrassing to
 * ship. Comparing only the end hour against a cutoff accepts a slot that runs
 * from 23:30 to 00:30, because its end hour is 0 and zero is less than five in
 * the afternoon. That is how "how about half past eleven tonight?" reaches a
 * user. A slot that does not begin and end on the same local day is rejected
 * before its hours are considered at all.
 */
function withinWakingHours(
  slot: CalendarWindow,
  timeZone: string,
  earliest: number,
  latest: number
): boolean {
  const start = wallClockIn(slot.from, timeZone);
  const end = wallClockIn(slot.to - 1, timeZone);

  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day;
  if (!sameDay) return false;

  if (start.hour < earliest || start.hour >= latest) return false;
  return end.hour < latest;
}

/**
 * The hour of the day at an instant, in a given zone.
 *
 * Uses the platform's own zone database rather than an offset we computed.
 * Offsets change — by government decision, sometimes at a few weeks' notice —
 * and a hard-coded one is wrong on a schedule nobody is watching for.
 */
export function hourInZone(instant: number, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).format(new Date(instant));
  return Number(formatted);
}

/** Local wall-clock parts at an instant, for moving an event without drift. */
export function wallClockIn(
  instant: number,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/**
 * Shift an event by whole days, keeping its local time.
 *
 * The distinction that matters: moving a 09:00 standup one week forward across a
 * daylight-saving change must still be 09:00, not 08:00 or 10:00. Naive
 * arithmetic adds 7×24 hours to the instant and silently produces the wrong
 * one — a bug that appears twice a year, affects one week, and is impossible to
 * reproduce when someone reports it in July.
 */
export function shiftByDays(
  event: CalendarEvent,
  days: number
): { startsAt: number; endsAt: number } {
  const durationMs = event.endsAt - event.startsAt;
  const local = wallClockIn(event.startsAt, event.timeZone);

  // Move the calendar date, then find the instant that lands on the same wall
  // clock in the event's own zone.
  const target = new Date(
    Date.UTC(local.year, local.month - 1, local.day + days, local.hour, local.minute)
  );
  const startsAt = instantForWallClock(target, event.timeZone);

  return { startsAt, endsAt: startsAt + durationMs };
}

/**
 * The UTC instant at which a given wall clock occurs in a zone.
 *
 * Solved by measuring the zone's offset at an approximate instant and correcting
 * once, which is exact everywhere except the hour a clock jumps — where no
 * answer is correct, because the wall clock either happened twice or not at all.
 */
function instantForWallClock(wallUtc: Date, timeZone: string): number {
  const guess = wallUtc.getTime();
  const observed = wallClockIn(guess, timeZone);
  const observedUtc = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute
  );
  return guess + (guess - observedUtc);
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

export type WriteRefusal =
  | "invites-others"
  | "in-the-past"
  | "backwards"
  | "conflicts"
  | "too-long";

export type WriteDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WriteRefusal; readonly message: string };

/** A meeting longer than this is a mistake, not a meeting. */
export const MAX_EVENT_MS = 12 * HOUR_MS;

export interface WriteCheck {
  readonly event: Omit<CalendarEvent, "id">;
  readonly existing: readonly CalendarEvent[];
  readonly now: number;
  /** True when the user has explicitly approved inviting these people. */
  readonly approvedInvites?: boolean;
  /** Set when the user has already been told about the clash and said go ahead. */
  readonly acceptedConflict?: boolean;
}

/**
 * Check an event before creating it.
 *
 * The first refusal is the one that matters. An event with attendees sends
 * invitations from the user to other people, who cannot tell it apart from the
 * user writing to them — so it meets the same bar as sending a message, not the
 * bar for editing a private list.
 */
export function checkWrite(check: WriteCheck): WriteDecision {
  const { event } = check;

  if (event.endsAt <= event.startsAt) {
    return { ok: false, reason: "backwards", message: "That event ends before it starts." };
  }
  if (event.endsAt - event.startsAt > MAX_EVENT_MS && event.allDay !== true) {
    return {
      ok: false,
      reason: "too-long",
      message: "That is longer than half a day — I have probably misread the time.",
    };
  }
  if (event.startsAt < check.now) {
    return {
      ok: false,
      reason: "in-the-past",
      message: "That time has already passed.",
    };
  }

  if (event.attendees.length > 0 && !check.approvedInvites) {
    const who = event.attendees.map((attendee) => attendee.email).join(", ");
    return {
      ok: false,
      reason: "invites-others",
      message: `That would send an invitation to ${who} from you. Confirm and I will.`,
    };
  }

  const clashes = conflictsWith(check.existing, { from: event.startsAt, to: event.endsAt });
  if (clashes.length > 0 && !check.acceptedConflict) {
    return {
      ok: false,
      reason: "conflicts",
      message: `That clashes with "${clashes[0]?.event.title ?? "something"}". Book it anyway?`,
    };
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Proactivity                                                                 */
/* -------------------------------------------------------------------------- */

export interface MeetingTrigger {
  readonly event: CalendarEvent;
  readonly minutesUntil: number;
  /** What the agent could usefully do before this starts. */
  readonly reason: "needs-travel" | "needs-preparation" | "starting-soon";
}

export const TRAVEL_LEAD_MINUTES = 60;
export const PREP_LEAD_MINUTES = 30;
export const IMMINENT_MINUTES = 10;

/**
 * Meetings worth doing something about now.
 *
 * The useful proactive hook, and the one that has to be quiet: an assistant that
 * announces every meeting is a notification the user turns off, after which it
 * cannot tell them the one thing that mattered. So only three cases fire —
 * somewhere to travel to, several attendees to prepare for, or a start that is
 * imminent — and each fires once.
 */
export function meetingTriggers(
  events: readonly CalendarEvent[],
  now: number
): readonly MeetingTrigger[] {
  const triggers: MeetingTrigger[] = [];

  for (const event of events) {
    if (event.response === "declined" || event.allDay === true) continue;

    const minutesUntil = Math.round((event.startsAt - now) / 60_000);
    if (minutesUntil < 0) continue;

    // A physical location means leaving, and leaving takes longer than people
    // allow for. This is the trigger that actually saves someone something.
    if (event.location && minutesUntil <= TRAVEL_LEAD_MINUTES && minutesUntil > PREP_LEAD_MINUTES) {
      triggers.push({ event, minutesUntil, reason: "needs-travel" });
      continue;
    }

    if (
      event.attendees.length >= 2 &&
      minutesUntil <= PREP_LEAD_MINUTES &&
      minutesUntil > IMMINENT_MINUTES
    ) {
      triggers.push({ event, minutesUntil, reason: "needs-preparation" });
      continue;
    }

    if (minutesUntil <= IMMINENT_MINUTES) {
      triggers.push({ event, minutesUntil, reason: "starting-soon" });
    }
  }

  return triggers.sort((a, b) => a.minutesUntil - b.minutesUntil);
}

export function describeTrigger(trigger: MeetingTrigger): string {
  const when = `in ${String(trigger.minutesUntil)} min`;

  switch (trigger.reason) {
    case "needs-travel":
      return `"${trigger.event.title}" is ${when} at ${trigger.event.location ?? "a location"}. Want me to check how long it takes to get there?`;
    case "needs-preparation":
      return `"${trigger.event.title}" is ${when} with ${String(trigger.event.attendees.length)} others. Want a summary of recent threads with them?`;
    case "starting-soon":
      return `"${trigger.event.title}" starts ${when}.`;
  }
}
