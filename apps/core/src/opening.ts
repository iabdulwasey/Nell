/**
 * Cutting the throat-clearing off the front of a reply.
 *
 * The prompt has asked three times, in three different ways, for the first line
 * to be the answer. First *"no exclamation marks, no 'perfect timing'"*, which
 * produced **"Perfect!"** — every banned example avoided, the habit untouched,
 * because a blocklist bans the examples. Then a rule about what the opening must
 * *be* rather than what it must not contain, which produced **"Perfect! Based on
 * today's weather conditions and the sun position at 5 PM, here's your
 * answer:"** — the rule quoted back and then broken in the same sentence.
 *
 * At that point it stops being a prompt problem. This codebase's whole argument
 * is that a guarantee which depends on the model remembering is a convention,
 * and a convention fails on the day it matters. The stakes here are cosmetic
 * rather than financial, but the reasoning is identical and the fix is cheap: a
 * rule enforced in code cannot be forgotten by a model having an off day.
 *
 * **Deliberately narrow, because the failure mode of trimming output is eating
 * an answer.** Three conditions must all hold: the line is short, it matches a
 * shape that carries no information, and there is real content behind it. A
 * reply that is *only* "Got it." is left exactly as it is — brevity is not
 * throat-clearing, and something is always better than nothing.
 */

/**
 * Openings that say nothing.
 *
 * Each is anchored to the start and bounded in length, so a sentence that merely
 * begins with one of these words survives: "Perfect weather for it — the fog
 * clears at four" is an answer, and "Perfect!" is not.
 */
const FILLER = [
  /** An acknowledgement on its own: "Perfect!", "Great.", "Absolutely!" */
  /^(perfect|great|excellent|wonderful|awesome|sure|absolutely|certainly|understood|got it|of course|happy to help|no problem)\b[\s!.,:—-]*$/iu,
  /** A promise that an answer follows, in place of the answer. */
  /^here('|’)?s (your answer|what i found|the answer|what you asked for)\b[\s:.!—-]*$/iu,
  /**
   * "Based on my research, here's your answer:" — a preamble with a citation.
   *
   * The promise is required explicitly. An earlier version accepted a bare
   * trailing colon and **ate a real answer on its first test**: "Based on the
   * tide table, low water is at 15:12 — go then" splits at the colon in the
   * time, and "Based on the tide table, low water is at 15:" then looks exactly
   * like a preamble. Precisely the failure this file's header warns about,
   * arriving immediately, which is the argument for writing the negative cases
   * first.
   */
  /^(based on|according to|after (searching|looking|checking|reviewing))\b.{0,120}?here('|’)?s\b.{0,40}$/iu,
  /** "Let me help you with that." */
  /^(let me|i('|’)?ll) (help|answer|look|check|find|walk you)\b.{0,60}$/iu,
  /** A restatement: "You asked about the fog in SF." */
  /^(you asked|your question was|to answer your question)\b.{0,120}$/iu,
];

/** Long enough to be content; short enough that no real opening is this brief. */
const FILLER_MAX_LENGTH = 160;

/**
 * The reply, with any opening that says nothing removed.
 *
 * Applied more than once, because the observed failure stacked two of them in a
 * single line and a model that writes one preamble will happily write two.
 * Bounded rather than looped to exhaustion: three passes is more than the
 * behaviour has ever produced, and an unbounded trim on model output is exactly
 * the kind of thing that eventually eats an answer.
 */
export function withoutThroatClearing(reply: string): string {
  let text = reply.trimStart();

  for (let pass = 0; pass < 3; pass += 1) {
    const trimmed = stripOnce(text);
    if (trimmed === text) break;
    text = trimmed;
  }

  return text;
}

function stripOnce(text: string): string {
  /**
   * The first *sentence*, not the first line.
   *
   * "Perfect! Based on today's weather… here's your answer:" is one line and two
   * pieces of filler, so splitting on lines would have found neither. The split
   * keeps its delimiter so the rest of the line survives intact.
   */
  // A colon between digits is a time or a ratio, never the end of a sentence.
  const match = /^([^\n]{1,200}?(?:[.!?]|(?<!\d):(?!\d))|[^\n]{1,200}?\n)\s*/u.exec(text);
  if (!match?.[1]) return text;

  const opening = match[1].trim();
  if (opening.length > FILLER_MAX_LENGTH) return text;
  if (!FILLER.some((pattern) => pattern.test(opening))) return text;

  const rest = text.slice(match[0].length).trimStart();

  /**
   * Never leave nothing behind.
   *
   * A reply that is only "Got it." is short, not evasive, and deleting it turns
   * a brief answer into silence — which is worse than the thing being fixed.
   */
  return rest.length > 0 ? rest : text;
}
