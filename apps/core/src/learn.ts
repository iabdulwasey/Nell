/**
 * Noticing things about somebody, rather than waiting to be told twice.
 *
 * Nell renders `USER.md`, `MEMORY.md` and `TASKS.md` — the whole file-based
 * memory idea, kept as rows and rendered as markdown so it gets the benefits
 * without the weaknesses. What it did not have was anything that **fills them**.
 *
 * Counted honestly before writing this: the running agent learned exactly one
 * thing on its own — the user's location, written by two call sites that store
 * the same key. `addRule`, which writes the standing rules `USER.md` is made of,
 * was called by **nothing but tests**. Every other fact required the person to
 * type `/remember` at it. So the documents were a good renderer over almost
 * empty tables, and "Nell remembers you" meant "Nell remembers where you live".
 *
 * The agents this borrows from write things down as they go, and that is the
 * whole of why they feel like they know you. This is that, with the one
 * constraint that must not be traded away for it.
 *
 * **Only what the user said, ever.** A page cannot plant a preference and
 * neither can Nell's own reply — which quotes pages, and would launder one into
 * permanent memory where every future turn reloads it. The architecture is
 * emphatic that memory writes accept only user-authored lineage, and the
 * cheapest way to keep a rule like that is to make the function take nothing
 * else: this reads one message, the user's, and has no parameter through which
 * page text could arrive.
 *
 * Two stages in the order the recurrence recogniser established: a cheap test
 * decides whether a message is even *about* the person, and only then does a
 * model extract. Most messages are "ok" or "book me a table", and putting a
 * round trip in front of those would be a bill on every turn.
 */

import type { ModelProvider } from "@nell/agent";
import { z } from "zod";

/**
 * Does this message say something durable about the person?
 *
 * First-person statements of habit, preference and constraint. Deliberately
 * wide, because the gate is a cost optimisation rather than a correctness
 * control: a false positive spends one small structured call which answers
 * "nothing here", and a false negative loses the fact silently and for ever.
 *
 * `remember`/`note` are included because people say "remember that I…" without
 * knowing a slash command exists, and that sentence is the clearest possible
 * signal of intent to be remembered.
 */
const ABOUT_THE_PERSON =
  /\b(i (always|never|usually|prefer|like|hate|don'?t|do not|can'?t|cannot|am|work|live|fly|drive|need|want)|my |i'?m |we (always|never|usually|prefer)|remember (that|this)|note that|from now on|going forward|please (always|never)|allerg|vegetarian|vegan|halal|kosher|wheelchair|budget)\b/iu;

/**
 * A standing rule given as a bare instruction, with no "I" in it.
 *
 * Caught by the first test written against it: *"never book anything before
 * 9am"* is exactly how somebody states a rule, and the pattern above wants
 * *"I never…"*. The same shape as the `everyday` miss in the recurrence gate —
 * a pattern built from the phrasings I happened to think of, tested with the
 * phrasings I happened to think of.
 */
const A_BARE_INSTRUCTION = /^\s*(always|never|don'?t|do not|avoid|stop|make sure)\b/iu;

export function mightSaySomethingAboutThem(text: string): boolean {
  return ABOUT_THE_PERSON.test(text) || A_BARE_INSTRUCTION.test(text);
}

const learnedSchema = {
  type: "object",
  properties: {
    preferences: {
      type: "array",
      description:
        "Durable FACTS about this person that would still be true next month. " +
        "Not what they want done right now — 'book me a table Friday' is a task, " +
        "not a fact. Empty when there is nothing worth keeping.",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "A stable dotted key, so restating the fact later replaces it rather " +
              "than accumulating: travel.seat, food.diet, travel.airline.",
          },
          value: { type: "string", description: "The value, in their own words where possible." },
          category: {
            type: "string",
            enum: [
              "travel",
              "payment",
              "communication",
              "schedule",
              "household",
              "shopping",
              "other",
            ],
          },
        },
        required: ["key", "value", "category"],
      },
    },
    rules: {
      type: "array",
      description:
        "Standing instructions to obey — 'never book before 9am', 'always ask " +
        "before spending over £50'. A rule is something they want DONE or NOT " +
        "done, where a preference is something that is simply true. Rarer than " +
        "preferences; empty is the common answer.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["always", "never", "prefer", "ask-first"] },
          rule: { type: "string", description: "The instruction, as a standalone sentence." },
        },
        required: ["kind", "rule"],
      },
    },
  },
  required: ["preferences", "rules"],
};

const parsed = z.object({
  preferences: z
    .array(
      z.object({
        key: z.string().min(1).max(80),
        value: z.string().min(1).max(500),
        category: z.enum([
          "travel",
          "payment",
          "communication",
          "schedule",
          "household",
          "shopping",
          "other",
        ]),
      })
    )
    .default([]),
  rules: z
    .array(
      z.object({
        kind: z.enum(["always", "never", "prefer", "ask-first"]),
        rule: z.string().min(1).max(500),
      })
    )
    .default([]),
});

export type Learned = z.infer<typeof parsed>;

export interface LearnOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  /** Keys already held, so the model is not asked to rediscover them. */
  readonly known?: readonly string[];
}

/**
 * How much may be learned from one message.
 *
 * A model asked what it noticed will happily produce nine facts from a sentence,
 * and a profile that grows nine rows per turn is one nobody can read and every
 * prompt has to carry. Anything genuinely important gets said again.
 */
export const MAX_PER_MESSAGE = 3;

/**
 * What this message says about the person.
 *
 * `theirWords` is the parameter name on purpose: it is the only thing that may
 * be passed, and there is nowhere else for text to enter. A caller reaching for
 * a page's contents finds no argument that takes them.
 */
export async function learnFrom(
  theirWords: string,
  options: LearnOptions
): Promise<Learned | undefined> {
  if (!mightSaySomethingAboutThem(theirWords)) return undefined;

  const known = options.known?.length ? `\n\nAlready known: ${options.known.join(", ")}` : "";

  const outcome = await options.provider.complete({
    model: options.model,
    system:
      "Extract durable facts and standing rules about the person from what they said. " +
      "A fact is something still true next month; a request for something to happen now " +
      "is a task and not a fact. Return nothing when there is nothing worth keeping — " +
      "that is the common answer, and a profile full of trivia is worse than a short one.",
    schema: learnedSchema,
    messages: [{ role: "user", content: `They said: ${theirWords}${known}` }],
  });

  if (!outcome.ok) return undefined;

  const result = parsed.safeParse(outcome.value);
  if (!result.success) return undefined;

  const learned: Learned = {
    preferences: result.data.preferences.slice(0, MAX_PER_MESSAGE),
    rules: result.data.rules.slice(0, MAX_PER_MESSAGE),
  };

  return learned.preferences.length > 0 || learned.rules.length > 0 ? learned : undefined;
}

/** What to tell them, so a silent profile change is never a surprise. */
export function describeLearned(learned: Learned): string {
  const parts = [
    ...learned.preferences.map((preference) => preference.value),
    ...learned.rules.map((rule) => rule.rule),
  ];
  if (parts.length === 0) return "";

  /**
   * Said out loud, briefly, and that is a design decision rather than a nicety.
   *
   * A profile that changes without a word is one somebody discovers by being
   * surprised months later — and the competitor's own privacy scandal was
   * precisely that shape. One short line makes it correctable while they are
   * still thinking about it, and `/memory` makes it correctable afterwards.
   */
  return `Noted: ${parts.join("; ")}.`;
}
