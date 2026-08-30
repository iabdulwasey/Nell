/**
 * Getting to know someone, without going looking.
 *
 * A new assistant knows nothing, and the obvious fix is the wrong one. The
 * incumbent researches its user at signup — searches their name, reads what it
 * finds — and users described the result as unsettling rather than impressive,
 * which is the correct reaction to being investigated by a service you just
 * signed up to. It is also a poor trade: the useful facts are not on the
 * internet. Whether someone likes an aisle seat is not a searchable fact about
 * them, and it is exactly the sort of thing that makes an assistant feel like it
 * knows you.
 *
 * So this does the opposite. Nothing is looked up. Suggestions are derived from
 * what the user has already handed over — the accounts they chose to connect and
 * the tasks they have actually asked for — and every one of them is a *question*
 * rather than a conclusion.
 *
 * The distinction matters more than it looks. "I noticed you fly BA — shall I
 * remember you prefer aisle seats?" invites a correction and costs nothing if
 * wrong. "I've noted that you prefer aisle seats" is a system that has decided
 * something about a person without asking, which is how a memory fills up with
 * confident nonsense that the user then has to find and delete.
 */

import { z } from "zod";

/** Where an idea came from. Nothing else is a permitted source. */
export const suggestionSourceSchema = z.enum([
  /** They connected an account, which says what they use. */
  "connected-account",
  /** They asked for something, which says what they want. */
  "past-task",
  /** They said something in passing that looked like a standing preference. */
  "stated-in-passing",
]);

export type SuggestionSource = z.infer<typeof suggestionSourceSchema>;

export interface Suggestion {
  readonly id: string;
  readonly source: SuggestionSource;
  /**
   * Phrased as a question, always. Enforced by `isQuestion`, because a
   * suggestion that has quietly become a statement is a system deciding things
   * about someone.
   */
  readonly question: string;
  /** What would be remembered if they say yes. */
  readonly wouldRemember: string;
  /** The observation behind it, so "why are you asking?" has an answer. */
  readonly because: string;
}

export interface OnboardingSignal {
  readonly kind: SuggestionSource;
  /** Service name, task objective, or the phrase they used. */
  readonly detail: string;
  readonly at: number;
  /** How many times this has been seen. Once is a coincidence. */
  readonly occurrences: number;
}

/**
 * How often something must recur before it is worth asking about.
 *
 * Once is an event, not a preference. Asking after a single flight produces an
 * assistant that pesters, and a user who learns to dismiss its questions without
 * reading them — after which the useful one goes unread too.
 */
export const MIN_OCCURRENCES = 2;

/** Nobody wants to be interviewed. */
export const MAX_SUGGESTIONS = 3;

/**
 * Turn what is already known into questions worth asking.
 *
 * Note what is absent: any parameter that could carry a search result, a name to
 * look up, or a public profile. The type makes the "research the user" version
 * of this feature unavailable rather than discouraged.
 */
export function suggestFrom(
  signals: readonly OnboardingSignal[],
  now: number
): readonly Suggestion[] {
  const worthAsking = signals
    .filter(
      (signal) => signal.occurrences >= MIN_OCCURRENCES || signal.kind === "connected-account"
    )
    // Most recent first: what someone did this week is a better guess at what
    // they care about than what they did in their first hour.
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SUGGESTIONS);

  return worthAsking.map((signal, index) => toSuggestion(signal, index, now));
}

function toSuggestion(signal: OnboardingSignal, index: number, now: number): Suggestion {
  const id = `onboarding-${String(now)}-${String(index)}`;

  switch (signal.kind) {
    case "connected-account":
      return {
        id,
        source: signal.kind,
        question: `You connected ${signal.detail}. Would you like me to keep an eye on it and tell you when something needs you?`,
        wouldRemember: `Watch ${signal.detail} for anything that needs attention.`,
        because: `You connected ${signal.detail}.`,
      };
    case "past-task":
      return {
        id,
        source: signal.kind,
        question: `You have asked me to ${signal.detail} a few times. Shall I offer next time rather than waiting to be asked?`,
        wouldRemember: `Offer to ${signal.detail} when it comes round.`,
        because: `You have asked for this ${String(signal.occurrences)} times.`,
      };
    case "stated-in-passing":
      return {
        id,
        source: signal.kind,
        question: `You mentioned "${signal.detail}". Should I remember that for next time?`,
        wouldRemember: signal.detail,
        because: "You said it while we were doing something else.",
      };
  }
}

/**
 * Whether a suggestion is actually phrased as a question.
 *
 * Checked rather than assumed. The difference between asking and asserting is
 * the whole design, and it is the kind of thing that erodes one careless edit at
 * a time — someone shortens a string, the question mark goes, and now the
 * assistant is telling people what it has decided about them.
 */
export function isQuestion(suggestion: Suggestion): boolean {
  return suggestion.question.trim().endsWith("?");
}

export interface SuggestionResponse {
  readonly suggestionId: string;
  readonly accepted: boolean;
}

/**
 * What to write down after the user answers.
 *
 * A rejection writes nothing at all — not a note that they declined, not a
 * negative preference. Recording "does not want X" from a single dismissal is
 * how a system turns "not now" into a permanent belief, and the user has no idea
 * it happened.
 */
export function memoryFor(
  suggestion: Suggestion,
  response: SuggestionResponse
): string | undefined {
  if (!response.accepted) return undefined;
  if (response.suggestionId !== suggestion.id) return undefined;
  return suggestion.wouldRemember;
}

/**
 * What the agent says on first contact.
 *
 * Says what it cannot do as plainly as what it can. A new assistant that opens
 * by listing capabilities invites the user to test the most ambitious one first;
 * one that says what it will ask permission for sets an expectation that holds
 * up.
 */
export function greeting(): string {
  return [
    "I can book things, fill in forms, chase up orders and keep an eye on things that change.",
    "",
    "Two things worth knowing before we start. I ask before I spend money or message anyone —",
    "every time, not just the first. And I only know what you tell me or what I learn from doing",
    "things for you; I have not looked you up, and I will not.",
    "",
    /**
     * Listed, because until now they were not.
     *
     * Four commands existed and `/help` returned this text without naming any of
     * them, so the only way to find one was to already know it was there. The
     * vault matters most: a saved login is the difference between "book me a
     * table" working and stopping at a sign-in, and nobody guesses at a command
     * to discover that.
     */
    "A few things I can be told directly:",
    "- /memory — everything I know about you, and everything I've done",
    "- /vault — logins I can sign in with, and how to add one",
    "- /schedules — anything I'm doing on a repeat, and /stop to cancel",
    "- /models — what this install can do, and which key would add the rest",
    "- /recall <anything> — search what I know, rather than reading all of it",
    /**
     * Listed rather than hidden, and last.
     *
     * A product whose pitch is honest deletion has to make deleting findable —
     * one that buries it is making the same claim the incumbent made and doing
     * the same thing with it. Last because it is the one command here that
     * cannot be undone.
     */
    "- /delete — remove what I know, what I have done, or everything",
    "",
    "What do you need?",
  ].join("\n");
}
