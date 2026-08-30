/**
 * Going back to check, because the answer might not survive the afternoon.
 *
 * The one thing a competitor did that Nell could not, and the most impressive
 * part of it. Asked at 11am where to photograph Sutro Tower at 5, it answered
 * well — and then at 4:21pm, unprompted, sent a second message: the fog is a
 * bust, skip the long exposures I mentioned, here is what to shoot instead.
 *
 * That is not a scheduling feature. Nell has had schedules since v1 and they
 * answer a different question: *"do this every morning"* is a standing
 * instruction the user typed. **This one nobody asks for.** It is the agent
 * noticing that the answer it just gave rests on something that will have
 * changed by the time the person acts on it, and deciding on its own to look
 * again.
 *
 * Three properties make it worth having rather than annoying:
 *
 * - **It is one-shot.** Tied to one answer, fires once, disappears. A recurring
 *   check would be a subscription nobody signed up for.
 * - **It carries what was originally said.** The value is in *"skip the 1/15
 *   exposures I mentioned"* — a correction to specific earlier advice, not a
 *   fresh weather report. A follow-up that cannot quote itself is just a second
 *   answer arriving late.
 * - **Silence is a valid outcome.** If the advice still stands, nothing is sent.
 *   This is the rule the monitors already run on, and it is the whole difference
 *   between a message worth reading and a notification people learn to ignore.
 *
 * Two stages, in the order the recurrence recogniser established: a cheap test
 * decides whether an answer *could* go stale, and only then does a model decide
 * whether it will and when to look. Putting a round-trip in front of every
 * answer would be a bill on "what is 15% of 847".
 */

import type { ModelProvider } from "@nell/agent";
import { z } from "zod";

/**
 * Could this answer be wrong in a few hours?
 *
 * The gate is about **a named future moment**, not about the topic. "What is the
 * weather" is a question about now and is answered once; "where should I be at
 * 5pm" makes a claim about a moment that has not happened yet, and that is the
 * shape that goes stale.
 *
 * Erring wide is cheap and erring narrow is invisible — the same trade the
 * recurrence gate makes. A false positive costs one small structured call which
 * answers "no follow-up needed"; a false negative loses the feature silently, on
 * exactly the request that would have shown it off.
 */
const A_FUTURE_MOMENT =
  /\b(today|tonight|this (morning|afternoon|evening)|tomorrow|later|at \d{1,2}\s*(am|pm|:\d{2})|\d{1,2}\s*(am|pm)\b|by \d|before \d|this weekend|kick.?off|departs?|arrives?|opens?|closes?|starts?|sunset|sunrise)\b/iu;

/**
 * Things that change on their own, between now and then.
 *
 * A recommendation only goes stale if the world moves underneath it. "What time
 * is sunset" is about a future moment and is *settled* — the almanac will not
 * revise itself. Weather, traffic, queues, prices and availability will.
 */
const A_MOVING_CONDITION =
  /\b(weather|forecast|fog|rain|snow|wind|storm|cloud|visibility|traffic|delay|queue|crowd|busy|wait|availability|available|in stock|sold out|price|fare|tickets?|seats?|open|closed|status|conditions?|tide|surf|pollen|aqi|air quality)\b/iu;

export function couldGoStale(objective: string, answer: string): boolean {
  const both = `${objective}\n${answer}`;
  return A_FUTURE_MOMENT.test(both) && A_MOVING_CONDITION.test(both);
}

const decisionSchema = {
  type: "object",
  properties: {
    worthChecking: {
      type: "boolean",
      description:
        "True only if this advice could be materially WRONG later because a real-world " +
        "condition will have changed. False for anything settled — sunset times, opening " +
        "hours published in advance, facts, arithmetic.",
    },
    minutesFromNow: {
      type: "integer",
      description:
        "When to look again. Aim to land shortly BEFORE the person would act — enough " +
        "time for the news to be useful. 45 minutes before the event is usually right.",
    },
    label: {
      type: "string",
      description: "A few words naming this, e.g. 'Sutro Tower fog check'.",
    },
    recheck: {
      type: "string",
      description:
        "A standalone instruction for the later check. It must name what to look at and " +
        "what would change the advice: 'Check the current fog and wind over San Francisco. " +
        "The advice was to shoot from Tank Hill at 5pm for fog wisps around Sutro Tower; " +
        "that fails if the marine layer stays coastal.'",
    },
  },
  required: ["worthChecking", "minutesFromNow", "label", "recheck"],
};

const parsedSchema = z.object({
  worthChecking: z.boolean().default(false),
  /**
   * Floored at ten minutes and capped at a day.
   *
   * A model asked "when should I look again" will occasionally say 1, which
   * would fire before the person has finished reading the first answer. The cap
   * is the other end: past a day this is a standing subscription, and those are
   * something the user asks for by name.
   */
  minutesFromNow: z
    .number()
    .int()
    .default(60)
    /**
     * Clamped, not rejected — and the first version rejected.
     *
     * `.min(10)` makes an out-of-range value fail the whole parse, so a model
     * that said "1 minute" threw away an otherwise sound decision over one
     * field. The comment above already said "floored", which is what it should
     * have done: a confused number is worth correcting, not worth losing the
     * feature over.
     */
    .transform((minutes) => Math.min(60 * 24, Math.max(10, minutes))),
  label: z.string().min(1).max(120).default("Follow-up"),
  recheck: z.string().min(1).max(2000).default(""),
});

export interface FollowUp {
  readonly label: string;
  readonly recheck: string;
  readonly runAt: number;
  /** What was originally advised, so the later message can correct itself. */
  readonly original: string;
}

export interface DecideOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly now?: number;
}

/**
 * Decide whether to look again, and when.
 *
 * Returns undefined on every failure path rather than throwing. A follow-up is
 * a bonus on top of an answer the user already has; a model that stutters over
 * the decision must not turn a delivered answer into a failed task.
 */
export async function decideFollowUp(
  objective: string,
  answer: string,
  options: DecideOptions
): Promise<FollowUp | undefined> {
  if (!couldGoStale(objective, answer)) return undefined;

  const outcome = await options.provider.complete({
    model: options.model,
    system:
      "You have just answered someone. Decide whether that answer could be materially wrong " +
      "later because a real-world condition will have changed by the time they act on it, and " +
      "if so when to look again. Be conservative: an unnecessary follow-up is a notification " +
      "nobody asked for, and people learn to ignore those.",
    schema: decisionSchema,
    messages: [{ role: "user", content: `They asked:\n${objective}\n\nI answered:\n${answer}` }],
  });

  if (!outcome.ok) return undefined;

  const parsed = parsedSchema.safeParse(outcome.value);
  if (!parsed.success || !parsed.data.worthChecking || !parsed.data.recheck.trim()) {
    return undefined;
  }

  const now = options.now ?? Date.now();
  return {
    label: parsed.data.label,
    recheck: parsed.data.recheck,
    runAt: now + parsed.data.minutesFromNow * 60_000,
    /**
     * Bounded, because this is stored and then put back into a prompt.
     *
     * The later check needs enough of the original to correct it specifically —
     * "skip the 1/15 exposures I mentioned" — and not the whole essay.
     */
    original: answer.slice(0, 1500),
  };
}

const verdictSchema = {
  type: "object",
  properties: {
    stillStands: {
      type: "boolean",
      description:
        "True if the original advice is still right. When true, nothing is sent — say true " +
        "unless something has genuinely changed.",
    },
    message: {
      type: "string",
      description:
        "What to send, only when the advice has changed. Write it as a second message to " +
        "someone who read the first: say what changed, correct the specific thing you told " +
        "them, and say whether it is still worth doing. No greeting, no preamble.",
    },
  },
  required: ["stillStands", "message"],
};

const verdictParsed = z.object({
  stillStands: z.boolean().default(true),
  message: z.string().max(4000).default(""),
});

/**
 * Given what was found on the second look, decide whether to say anything.
 *
 * The bar is deliberately high and the default is silence. A follow-up that
 * arrives to say "still fine" is the notification that teaches someone to stop
 * reading them, which costs them the one that mattered.
 */
export async function verdictOn(
  original: string,
  found: string,
  options: DecideOptions
): Promise<string | undefined> {
  const outcome = await options.provider.complete({
    model: options.model,
    system:
      "You told someone something earlier. You have just checked the conditions again. " +
      "Decide whether what you said still stands. Default to yes — only report back when " +
      "the advice has materially changed, and then correct the specific things you said.",
    schema: verdictSchema,
    messages: [
      { role: "user", content: `What I said earlier:\n${original}\n\nWhat I found now:\n${found}` },
    ],
  });

  if (!outcome.ok) return undefined;

  const parsed = verdictParsed.safeParse(outcome.value);
  if (!parsed.success || parsed.data.stillStands || !parsed.data.message.trim()) return undefined;

  return parsed.data.message.trim();
}
