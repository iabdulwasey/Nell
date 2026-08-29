/**
 * Recognising "every morning at 6" in a sentence.
 *
 * Two stages, and the order is the point. A regular expression decides whether
 * the message is *even about* recurrence; only then does a model call extract
 * the details. Asking a model to classify every inbound message would put a
 * round-trip and a bill in front of "hi", and the words that mean "do this
 * repeatedly" are a small, closed set in a way that times and phrasings are not.
 *
 * The model gets the second half because that half genuinely needs it: "every
 * morning", "each weekday at half six", "twice a day", and "every 6 am" are the
 * same request in four shapes, and a parser for them is a worse version of a
 * model with a schema.
 *
 * **Times are local to wherever this process runs.** Said plainly because it is
 * a real constraint rather than a detail: a user in another timezone from their
 * server would get their scan at the wrong hour, and the fix is a timezone on
 * the workspace, which does not exist yet.
 */

import type { ModelProvider } from "@nell/agent";
import { z } from "zod";

/**
 * Does this message ask for something repeated?
 *
 * Kept tight on purpose. A false positive costs a model call and a confused
 * answer; the words below do not appear by accident in a one-off request.
 */
const RECURRENCE =
  /\b(every|each|daily|nightly|hourly|weekly|recurring|repeatedly|each day|from now on)\b/iu;

/** "every time you finish" is about a task, not a clock. */
const NOT_A_SCHEDULE = /\b(every time|every step|each time|everything|every one|every single)\b/iu;

export function looksRecurring(text: string): boolean {
  return RECURRENCE.test(text) && !NOT_A_SCHEDULE.test(text);
}

const extractionSchema = {
  type: "object",
  properties: {
    recurring: {
      type: "boolean",
      description: "True only if the user is asking for something to happen repeatedly.",
    },
    everyMinutes: {
      type: "integer",
      description: "Gap between runs. Daily is 1440, hourly 60, twice a day 720.",
    },
    atHour: {
      type: "integer",
      description: "Hour of day for the first run, 0-23 local time. Use 9 if unstated.",
    },
    atMinute: { type: "integer", description: "Minute of the hour, 0-59. Usually 0." },
    label: { type: "string", description: "A few words naming this, e.g. 'AI news scan'." },
    task: {
      type: "string",
      description:
        "The work to do each time, as a standalone instruction with no scheduling words. " +
        "'Find today's AI and tech news and summarise the headlines.'",
    },
  },
  required: ["recurring", "everyMinutes", "atHour", "atMinute", "label", "task"],
};

const parsedSchema = z.object({
  recurring: z.boolean().default(false),
  // Floors at 15 minutes: anything tighter is a monitor, and a model asked for
  // "every few minutes" will happily say 1 and bill accordingly.
  everyMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24 * 30)
    .default(1440),
  atHour: z.number().int().min(0).max(23).default(9),
  atMinute: z.number().int().min(0).max(59).default(0),
  label: z.string().min(1).max(120).default("Scheduled task"),
  task: z.string().min(1).max(2000).default(""),
});

export interface ScheduleRequest {
  readonly everyMinutes: number;
  readonly firstRunAt: number;
  readonly label: string;
  readonly task: string;
}

export interface ParseOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  /** Injected so the first-run calculation is testable without waiting a day. */
  readonly now?: number;
}

/**
 * Pull a schedule out of a message, or decide there isn't one.
 *
 * Returns undefined rather than throwing on every failure path — a model that
 * stutters over "every morning" should leave the message to be treated as an
 * ordinary task, which still does the useful thing once.
 */
export async function parseScheduleRequest(
  text: string,
  options: ParseOptions
): Promise<ScheduleRequest | undefined> {
  if (!looksRecurring(text)) return undefined;

  const outcome = await options.provider.complete({
    model: options.model,
    system:
      "Extract a repeating schedule from the user's message. " +
      "The task must read as a standalone instruction with the scheduling words removed.",
    schema: extractionSchema,
    messages: [{ role: "user", content: text }],
  });

  if (!outcome.ok) return undefined;

  const parsed = parsedSchema.safeParse(outcome.value);
  if (!parsed.success || !parsed.data.recurring || !parsed.data.task.trim()) return undefined;

  return {
    everyMinutes: parsed.data.everyMinutes,
    firstRunAt: nextOccurrence(parsed.data.atHour, parsed.data.atMinute, options.now ?? Date.now()),
    label: parsed.data.label,
    task: parsed.data.task.trim(),
  };
}

/**
 * The next time that clock time comes around.
 *
 * Today if it is still ahead, tomorrow otherwise. Setting up a 6am scan at 9am
 * and having it fire immediately — because 6am today is "due" — is the obvious
 * bug here, and it is the one that texts someone at 9am insisting it is their
 * morning briefing.
 */
export function nextOccurrence(hour: number, minute: number, now: number): number {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** How the confirmation reads. The user should be able to check it is right. */
export function describeSchedule(request: ScheduleRequest): string {
  const when = new Date(request.firstRunAt);
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = when.toDateString() === new Date().toDateString() ? "today" : "tomorrow";

  const cadence =
    request.everyMinutes === 1440
      ? "every day"
      : request.everyMinutes === 60
        ? "every hour"
        : request.everyMinutes % 1440 === 0
          ? `every ${String(request.everyMinutes / 1440)} days`
          : request.everyMinutes % 60 === 0
            ? `every ${String(request.everyMinutes / 60)} hours`
            : `every ${String(request.everyMinutes)} minutes`;

  return `I'll do that ${cadence}, starting ${day} at ${time}: ${request.task}`;
}
