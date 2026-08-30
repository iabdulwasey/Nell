/**
 * What a message arriving mid-task actually wants.
 *
 * `routeMessage` answers *"which task is this about?"* — a routing question, and
 * it answers it well. Nothing ever answered the second question: **what does
 * this message want done to that task?** Everything routed to a task became one
 * undifferentiated thing called "steering", appended to a list of instructions,
 * and that collapse is why a booking carried on for a hundred steps after being
 * told to abandon the cinema it was booking at.
 *
 * The distinction the user drew, and it is the right one, because each needs
 * something different done to the running task:
 *
 * - **The goal changed.** *"Forget sec 90 mall, book anywhere close."* The
 *   objective is now a different objective.
 * - **The goal stands and the approach is wrong.** *"Don't use that site."*
 *   *"Not the 9pm one."* A constraint, not a new goal.
 * - **Something else entirely**, to be done afterwards.
 *
 * **Why a redirect must discard the history, which is the part I had wrong.**
 * Replacing the objective string is not enough. The loop carries everything it
 * has tried, and after forty steps of hunting for one cinema that history *is*
 * an argument for hunting for that cinema — it outvoted a single line of
 * correction labelled "this outranks the objective", because one line against
 * forty is not a fair fight. On a redirect the history is not merely stale, it
 * is evidence for a goal that no longer exists, and the honest thing is to throw
 * it away.
 *
 * A refine keeps its history for exactly the same reason: there the goal is
 * unchanged, so what has already been tried is still worth knowing.
 *
 * This is a judgement and it differs every time, so a model makes it — with the
 * objective and what the task has recently been doing in front of it, because
 * *"not that one"* means nothing without knowing which one it has been on.
 */

import type { ModelProvider } from "@nell/agent";
import { z } from "zod";

export type MidTaskIntent =
  /** The goal is now a different goal. Objective replaced, history discarded. */
  | { readonly kind: "redirect"; readonly objective: string }
  /** Same goal, wrong approach. A constraint added to what it already knows. */
  | { readonly kind: "refine"; readonly constraint: string }
  /** Unrelated work, to be done after this. */
  | { readonly kind: "new-task" }
  /**
   * Work that **cannot start until the running task finishes**, because it
   * operates on that task's result.
   *
   * *"Book me a flight"* then *"and put it in my calendar"* — the second is not
   * a correction and not an independent request. Run concurrently it finds
   * nothing to add, which is how it behaved before this existed: the queue
   * released it on a free slot rather than on the thing it needed.
   */
  | { readonly kind: "after-this" }
  /** The same request again, because nothing appeared to be happening. */
  | { readonly kind: "repeat" };

const intentSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["redirect", "refine", "new-task", "after-this", "repeat"],
      description:
        "redirect: the user has changed what they want done — a different place, date, " +
        "item or destination, or an explicit 'forget that'. " +
        "refine: the goal is unchanged and they are correcting HOW — avoid a site, pick a " +
        "different option, stop doing something that is not working. " +
        "new-task: unrelated work, which can run at any time. " +
        "after-this: work that OPERATES ON the running task's result and cannot start " +
        "until it finishes — 'and add it to my calendar', 'then email me the confirmation'. " +
        "repeat: they have sent essentially the same request again, most likely because " +
        "nothing seemed to be happening.",
    },
    objective: {
      type: "string",
      description:
        "For redirect ONLY. The complete new objective as a standalone instruction, " +
        "carrying everything from the original that still applies and nothing that does " +
        "not. Original 'Book 2 good seats at sec 90 mall' plus 'forget sec 90, book " +
        "anywhere close' becomes 'Book 2 good seats for Spider-Man at any cinema near " +
        "the user, for a show after 9pm'. Never mention the abandoned detail.",
    },
    constraint: {
      type: "string",
      description:
        "For refine ONLY. The correction, as an instruction that stands on its own: " +
        "'Do not use bookmyshow, it blocks automated browsers.'",
    },
  },
  required: ["kind"],
};

const parsed = z.object({
  kind: z.enum(["redirect", "refine", "new-task", "after-this", "repeat"]).default("refine"),
  objective: z.string().max(2000).default(""),
  constraint: z.string().max(2000).default(""),
});

export interface ClassifyOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  /** The running task's objective, as it currently stands. */
  readonly objective: string;
  /** A little of what it has lately been doing. "Not that one" needs a *that*. */
  readonly recently?: readonly string[];
}

/**
 * Work out what to do with a message that arrived while a task was running.
 *
 * Falls back to `refine` on every failure path, and that default is deliberate.
 * Refine is the *least destructive* reading: the objective survives, the history
 * survives, and the message reaches the model as a constraint. Defaulting to
 * redirect would let a stuttering classifier throw away a task's entire context,
 * which is a much worse way to be wrong.
 */
export async function classifyMidTask(
  text: string,
  options: ClassifyOptions
): Promise<MidTaskIntent> {
  const recently = (options.recently ?? []).slice(-6).join("\n");

  const outcome = await options.provider.complete({
    model: options.model,
    system:
      "A task is already running for this user and they have just sent another message. " +
      "Decide what they want done to that task. Changing WHERE, WHEN or WHAT is a redirect; " +
      "correcting HOW it is going about an unchanged goal is a refine.",
    schema: intentSchema,
    messages: [
      {
        role: "user",
        content:
          `The running task: ${options.objective}\n\n` +
          (recently ? `What it has been doing:\n${recently}\n\n` : "") +
          `They have just said: ${text}`,
      },
    ],
  });

  if (!outcome.ok) return { kind: "refine", constraint: text };

  const result = parsed.safeParse(outcome.value);
  if (!result.success) return { kind: "refine", constraint: text };

  switch (result.data.kind) {
    case "redirect":
      /**
       * A redirect with no objective is not a redirect.
       *
       * Discarding the history on the strength of an empty string would leave a
       * task with no goal and no memory — every possible reading of the message
       * is better served by treating it as a constraint.
       */
      return result.data.objective.trim()
        ? { kind: "redirect", objective: result.data.objective.trim() }
        : { kind: "refine", constraint: text };
    case "new-task":
      return { kind: "new-task" };
    case "after-this":
      return { kind: "after-this" };
    case "repeat":
      return { kind: "repeat" };
    default:
      return { kind: "refine", constraint: result.data.constraint.trim() || text };
  }
}
