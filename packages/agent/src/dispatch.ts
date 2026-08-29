/**
 * What kind of job is this?
 *
 * The layer that was missing, and its absence is why a resume review failed.
 * `Intent` distinguishes conversation from work; `ModelRouter` picks a price
 * tier. Neither asks the question that decides everything: **what does this task
 * actually need in order to be done?**
 *
 * Without it there is one worker, it drives a browser, and every request goes
 * through it. So "read my resume and roast it" opened a browser — which cannot
 * read a file and has no reason to — and the failure looked like the model being
 * useless when it was the dispatch being wrong. The two fixes shipped before
 * this one, search and documents, were both special cases bolted around the
 * browser loop rather than a way of choosing between capabilities.
 *
 * **The ordering is the policy.** A browser is the slowest, most expensive and
 * most fragile way to get anything done — it is captcha'd, it times out, it
 * needs a session. It earns its place only when the answer is somewhere on the
 * live web behind interaction. Anything a model can do from what it already has
 * — the user's files, its own knowledge, a search result — should never touch
 * one. Cheapest capable path first, every time.
 *
 * **Almost everything is one step.** An earlier version of this had five
 * capabilities — answer, document, image, search, browse — each hand-written,
 * and that was the same mistake one level up: enumerating what a model can do
 * reaches exactly the list somebody thought of. A model that searches and runs
 * code covers producing a PDF, charting a file, converting a format and
 * packaging several things into one, and it chains those itself, in a single
 * request, better than a pipeline written in advance can.
 *
 * What remains genuinely separate is the one thing that model cannot do:
 * operate a real site, which needs a session, cookies and a browser.
 *
 * Drawing was a third capability here until image generation became a *tool* the
 * model calls mid-task. A specialist reached for during the work does not need a
 * step planned in advance — which is the same lesson as the rest of this file,
 * arrived at once more from the other direction.
 */

import { z } from "zod";
import type { CompletionOutcome, ModelProvider } from "./provider.js";

/**
 * What a step needs to be carried out.
 *
 * Deliberately about *capability*, not about which vendor supplies it. Which
 * model answers, draws or reads is the catalog's business; this is the question
 * of what has to happen, and the answer does not change when someone swaps
 * DeepSeek for GPT.
 */
export const capabilitySchema = z.enum([
  /**
   * The model does it: answers, searches the web, writes and runs code, and
   * produces whatever files that yields.
   *
   * One capability rather than four, and the collapse is the point. There were
   * separate `answer`, `search` and `document` capabilities here, each
   * hand-written, and the hand-written `document` one rendered HTML through
   * Chromium — which made PDFs from HTML and nothing else. A model that can run
   * code makes the PDF, and also the chart, the conversion, the five images
   * packaged into one file, and the thing nobody listed. Enumerating
   * capabilities reaches exactly the list someone thought of.
   */
  "assist",
  /**
   * A page must be driven: logged into, filled in, clicked through.
   *
   * The one thing a model with server-side tools cannot do — it has no session,
   * no cookies and no logins. Which is what a browser was always for.
   */
  "browse",
]);

export type Capability = z.infer<typeof capabilitySchema>;

export interface Step {
  readonly capability: Capability;
  /** What this step is for, in its own words — it becomes that worker's brief. */
  readonly instruction: string;
}

export interface Dispatch {
  readonly steps: readonly Step[];
  /** One line for the user, so a slow job is visibly the job they asked for. */
  readonly summary: string;
  /**
   * The request with everything it referred to spelled out.
   *
   * Equal to the message itself when nothing needed resolving, which is the
   * common case — so a caller can use this unconditionally rather than deciding
   * when a rewrite happened.
   */
  readonly objective: string;
}

/**
 * Requests that need no model call to classify.
 *
 * Not an optimisation so much as a floor: a router that occasionally decides a
 * greeting needs a browser is worse than no router, and these are the cases
 * where being wrong is both most likely and most annoying.
 */
const OBVIOUSLY_BROWSING =
  /\b(book|buy|order|purchase|reserve|check ?out|log ?in|sign ?in|apply|cancel my|pay for)\b/iu;

const dispatchSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "One short line naming what you are about to do, for the user to read.",
    },
    /**
     * The field that makes a follow-up work, and it belongs here rather than
     * anywhere downstream.
     *
     * "Book the second one" is not a task any worker can carry out — the second
     * of what is in the previous turn, which the worker never sees. Rewriting it
     * *here* into "book Emirates EK517, 8:40pm, 3 September to Delhi" fixes
     * follow-ups for both capabilities at once, because everything past this
     * point already takes an objective and nothing else has to change.
     *
     * The alternative — handing the whole conversation to every worker — is
     * worse in two ways: it pays for the history on every step of a multi-step
     * job, and it makes each worker responsible for resolving pronouns while it
     * is also trying to drive a page.
     */
    objective: {
      type: "string",
      description:
        "The request rewritten so it stands alone, with anything it refers to from earlier " +
        "spelled out — names, numbers, dates, prices. If it already stands alone, repeat it " +
        "unchanged. Never invent a detail that was not said.",
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description:
        "The steps needed, in order, each feeding the next. Use the fewest that will do. " +
        "Do not add a browse step for something you already know or can read in an " +
        "attached file — browsing is slow, fragile, and often blocked.",
      items: {
        type: "object",
        properties: {
          capability: {
            type: "string",
            enum: capabilitySchema.options,
            description:
              "assist: the model answers, searches the web, runs code, and calls out to " +
              "other models for anything it cannot do itself — this covers almost " +
              "everything, including PDFs, charts, spreadsheets, conversions and pictures. " +
              "browse: drive a real page — click, fill in, log in, check out. Slowest and " +
              "most fragile; use only when the task needs a site actually operated.",
          },
          instruction: {
            type: "string",
            description: "What this step should do, written as a brief for whoever does it.",
          },
        },
        required: ["capability", "instruction"],
      },
    },
  },
  required: ["summary", "objective", "steps"],
};

const parsed = z.object({
  summary: z.string().max(200).default(""),
  objective: z.string().max(2000).default(""),
  steps: z
    .array(
      z.object({
        capability: capabilitySchema,
        instruction: z.string().min(1).max(2000),
      })
    )
    .min(1)
    .max(4),
});

export interface DispatchRequest {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly message: string;
  /** Names of files the user has sent, which change what is answerable without the web. */
  readonly files?: readonly string[];
  /**
   * What has been said before, already rendered and already carrying its own
   * framing about which parts are trusted.
   *
   * Rendered by the caller rather than passed as turns, because the rule that
   * the user's words authorize and Nell's past replies only inform is a
   * property of how it is *shown*, and one place should own that sentence.
   */
  readonly conversation?: string;
  /** What Nell knows about this person, as the brain document. */
  readonly profile?: string;
  /**
   * Today's date.
   *
   * The planner has had this for weeks and the dispatcher never did, which
   * showed up the moment it started resolving follow-ups: a conversation
   * mentioning "3 September" with no year became "3 September 2025" — the
   * model's training cutoff, written in confidently while being told to invent
   * nothing. A rewrite that fills in the wrong year is worse than one that
   * leaves it out, because the year now looks like something the user said.
   */
  readonly today?: string;
  readonly timeoutMs?: number;
}

/**
 * Decide what a request needs.
 *
 * Falls back to browsing when the model cannot be reached, because that is the
 * capability that can attempt the widest range of tasks — a wrong browse is slow
 * and usually recoverable, where a wrong "answer" is a confident reply to a
 * question that needed the live web.
 */
export async function planWork(request: DispatchRequest): Promise<Dispatch> {
  const files = request.files ?? [];

  /**
   * A file plus a question is a question about the file.
   *
   * The exact case that failed, and it is answered without a model call because
   * the alternative — asking a router whether "roast my resume" is about the
   * resume the user just sent — is a round trip to be told something already
   * known.
   */
  if (files.length > 0) {
    return {
      summary: "Reading what you sent.",
      objective: request.message,
      steps: [{ capability: "assist", instruction: request.message }],
    };
  }

  const outcome: CompletionOutcome = await request.provider.complete({
    model: request.model,
    system: [
      `Today is ${request.today ?? new Date().toDateString()}.`,
      "",
      "Decide what a request needs, and choose the cheapest way that will actually work.",
      "",
      "Almost everything is `assist`: the model can answer, search the live web, and write",
      "and run code — so producing a PDF, charting data, converting a file or packaging",
      "several into one are all a single assist step, not several.",
      "",
      "A browser is slow, often blocked by captchas, and can fail outright. Use it only",
      "when a real site must be operated: booking, buying, logging in, filling a form.",
      "Never open one for something the model can work out or look up.",
      "",
      "Use one step unless the job genuinely needs a different capability part-way —",
      "generating pictures then packaging them, or browsing for something then writing it",
      "up. Steps run in order and feed each other.",
      "",
      "A message is often a follow-up: 'book the second one', 'what about Thursday', 'no,",
      "the earlier flight'. Read what was said before and write `objective` so it stands on",
      "its own — the worker doing it never sees the conversation. Carry across the exact",
      "names, numbers and dates that were mentioned, and invent nothing that was not.",
      files.length > 0 ? `\nThe user has sent: ${files.join(", ")}.` : "",
    ].join("\n"),
    schema: dispatchSchema,
    timeoutMs: request.timeoutMs,
    messages: [
      {
        role: "user",
        content: [
          request.profile?.trim() ? `${request.profile.trim()}\n` : "",
          request.conversation?.trim() ? `${request.conversation.trim()}\n` : "",
          `They have now said: ${request.message}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  if (!outcome.ok) return fallback(request.message);

  const result = parsed.safeParse(outcome.value);
  if (!result.success) return fallback(request.message);

  return {
    summary: result.data.summary,
    // Falling back to the raw message rather than to an empty string: a model
    // that skips the field must not erase the request.
    objective: result.data.objective.trim() || request.message,
    steps: result.data.steps,
  };
}

/** When the router cannot say, browse: it can attempt the most, and fails visibly. */
function fallback(message: string): Dispatch {
  return {
    summary: "Having a look.",
    objective: message,
    steps: [
      {
        capability: OBVIOUSLY_BROWSING.test(message) ? "browse" : "assist",
        instruction: message,
      },
    ],
  };
}

/**
 * Whether a plan can be carried out with what is bound.
 *
 * A capability with no provider behind it is not a failure to hide: telling
 * someone their agent cannot generate images, and why, is worth more than a
 * broken attempt or a silent omission from the result.
 */
export function unsupported(
  steps: readonly Step[],
  available: ReadonlySet<Capability>
): readonly Capability[] {
  return [...new Set(steps.map((step) => step.capability))].filter(
    (capability) => !available.has(capability)
  );
}

export function explainUnsupported(missing: readonly Capability[]): string {
  const names: Readonly<Record<Capability, string>> = {
    assist: "work that out",
    browse: "use a browser",
  };

  const list = missing.map((capability) => names[capability]).join(" or ");
  return `I can't ${list} yet — that needs a model key I don't have configured.`;
}
