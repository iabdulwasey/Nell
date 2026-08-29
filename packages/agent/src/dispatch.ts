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
 * **Steps compose, and that is the point of a pipeline rather than a label.**
 * "Make three images and put them in one PDF" is an image step feeding a
 * document step; "research X and write it up" is a browse step feeding a
 * document step. The output of one is the input of the next, and no single
 * capability can do either job alone.
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
  /** A model answers from what it already has: its knowledge and the user's files. */
  "answer",
  /** A file is produced — a PDF, a document — from text a model writes. */
  "document",
  /** Pictures are generated. */
  "image",
  /** The live web is searched; results are read, nothing is clicked. */
  "search",
  /** A page must be driven: logged into, filled in, clicked through. */
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

const OBVIOUSLY_A_DOCUMENT =
  /\b(make|create|write|generate|produce|give me|send me|export)\b[^.?!]*\b(pdf|document|doc|docx|report|deck|letter|cv|resume|invoice|summary document)\b/iu;

const dispatchSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "One short line naming what you are about to do, for the user to read.",
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
              "answer: a model replies from its knowledge or the user's files. " +
              "document: produce a PDF or document file. " +
              "image: generate pictures. " +
              "search: look things up on the web and read the results. " +
              "browse: drive a page — click, fill in, log in. Slowest and most fragile; " +
              "use only when the task needs interaction with a site.",
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
  required: ["summary", "steps"],
};

const parsed = z.object({
  summary: z.string().max(200).default(""),
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
  if (files.length > 0 && !OBVIOUSLY_A_DOCUMENT.test(request.message)) {
    return {
      summary: "Reading what you sent.",
      steps: [{ capability: "answer", instruction: request.message }],
    };
  }

  const outcome: CompletionOutcome = await request.provider.complete({
    model: request.model,
    system: [
      "Decide what a request needs, and choose the cheapest way that will actually work.",
      "",
      "A browser is slow, often blocked by captchas, and can fail outright. Use it only",
      "when the task needs a page driven — booking, buying, logging in, filling a form.",
      "To look something up, use search. To answer from knowledge or from a file the user",
      "sent, use answer. Never open a browser for something you already know.",
      "",
      "Steps run in order and feed each other: images then a document, or search then a",
      "document. Use the fewest steps that do the job.",
      files.length > 0 ? `\nThe user has sent: ${files.join(", ")}.` : "",
    ].join("\n"),
    schema: dispatchSchema,
    timeoutMs: request.timeoutMs,
    messages: [{ role: "user", content: request.message }],
  });

  if (!outcome.ok) return fallback(request.message);

  const result = parsed.safeParse(outcome.value);
  if (!result.success) return fallback(request.message);

  return { summary: result.data.summary, steps: result.data.steps };
}

/** When the router cannot say, browse: it can attempt the most, and fails visibly. */
function fallback(message: string): Dispatch {
  return {
    summary: "Having a look.",
    steps: [
      {
        capability: OBVIOUSLY_BROWSING.test(message) ? "browse" : "search",
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
    answer: "answer questions",
    document: "produce documents",
    image: "generate images",
    search: "search the web",
    browse: "use a browser",
  };

  const list = missing.map((capability) => names[capability]).join(" or ");
  return `I can't ${list} yet — that needs a model key I don't have configured.`;
}
