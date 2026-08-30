/**
 * Noticing that you are doing the same thing again.
 *
 * The loop already bounds two failures well. It stops a task that stalls, and it
 * stops one going in circles — `seen` holds every page fingerprint, so revisiting
 * somewhere is silent and only somewhere *new* resets the clock.
 *
 * Neither caught the worst run this agent has had. Booking cinema seats, it
 * clicked one "Proceed" button **41 times**, then tried to reduce a selection to
 * two seats and drove it **2 → 4 → 5 → 6 → 7 → 8 → 9 → 10** — believing on every
 * turn that it was deselecting. It ran 245 steps and gave up on a timer.
 *
 * **Why both bounds missed it, and it is the same reason twice: novelty is not
 * progress.** Each click genuinely changed the page — a different seat count, a
 * different highlight — so each fingerprint was genuinely new, `seen` grew
 * forever, and the stall clock reset every turn. The agent was not standing
 * still and was not going in circles. It was moving steadily away from the goal,
 * and *"somewhere new"* cannot tell that from *"somewhere better"*.
 *
 * What it *was* doing, unmistakably, is the same action against the same thing,
 * over and over. That is what this measures.
 *
 * **Why the action and not the model's reasoning.** The reasoning was reworded
 * every single time — *"clicking more precisely on the center"*, *"a different
 * approach — targeting the exact text center"*, *"trying the middle-left area"*.
 * Comparing that text finds four different sentences and concludes the agent is
 * exploring. It was clicking the same button. **Where the words differ and the
 * deed is identical, believe the deed.**
 */

import type { PageSnapshot } from "@nell/browser";

/**
 * How many identical turns before the agent is told to stop doing that.
 *
 * Generous on purpose. Legitimately repeating an action a few times is ordinary
 * — a page that needs a second click, a scroll through a long list — and a bound
 * that fires on the third would spend its credibility on normal behaviour.
 * Nothing honest does the same thing four times running and expects the fifth to
 * differ.
 */
export const REPEATING_AFTER = 4;

/**
 * How many before it gives up rather than nagging.
 *
 * A warning that is ignored twice is not a warning. Watched live: nudging the
 * model with "that is not working" bought two more differently-worded attempts
 * at the same click, so the second threshold ends the task honestly rather than
 * letting it run to the five-minute timer having achieved nothing.
 */
export const REPEATING_LIMIT = 8;

/**
 * What an action does, and to what — with the page's own naming resolved.
 *
 * A ref is `<version>:e<n>` and the version changes with every snapshot, so two
 * clicks on one button carry different refs and look like different actions.
 * Resolving the ref against the snapshot recovers what the model was actually
 * aiming at: the role and the visible name, which are what stay the same.
 *
 * Undefined for anything whose target cannot be identified. A signature that
 * cannot distinguish two elements would report every click as a repeat, and a
 * detector with false positives on ordinary work gets switched off.
 */
export function actionSignature(action: unknown, snapshot?: PageSnapshot): string | undefined {
  if (typeof action !== "object" || action === null) return undefined;
  const record = action as Record<string, unknown>;
  const kind = typeof record["action"] === "string" ? record["action"] : undefined;
  if (!kind) return undefined;

  // Navigation names its own destination, and repeating it is a real loop.
  if (kind === "goto") {
    const url = typeof record["url"] === "string" ? record["url"] : "";
    return url ? `goto:${url}` : undefined;
  }

  const target = record["target"];
  if (typeof target !== "object" || target === null) {
    // Scrolling and going back carry no target; the direction is the identity.
    const direction = typeof record["direction"] === "string" ? record["direction"] : "";
    return `${kind}${direction ? `:${direction}` : ""}`;
  }

  const named = describeTarget(target as Record<string, unknown>, snapshot);
  return named ? `${kind}:${named}` : undefined;
}

function describeTarget(
  target: Record<string, unknown>,
  snapshot?: PageSnapshot
): string | undefined {
  const by = typeof target["by"] === "string" ? target["by"] : "";
  const text = (key: string) => (typeof target[key] === "string" ? target[key] : "");

  switch (by) {
    case "role":
      return `${text("role")}/${text("name").toLowerCase()}`;
    case "label":
    case "placeholder":
    case "text":
      return `text/${text("text").toLowerCase()}`;
    case "testId":
      return `testId/${text("id")}`;
    case "css":
      return `css/${text("selector")}`;
    case "ref": {
      /**
       * The case the whole file turns on.
       *
       * Without this a ref is unusable — it changes every snapshot — and the 41
       * identical clicks would each carry a different signature and read as 41
       * different actions.
       */
      const ref = text("ref");
      const node = snapshot?.nodes.find((candidate) => candidate.ref === ref);
      return node ? `${node.role}/${(node.name ?? "").toLowerCase()}` : undefined;
    }
    default:
      return undefined;
  }
}

/** One turn's worth of actions, as a single comparable string. */
export function turnSignature(
  actions: readonly unknown[],
  snapshot?: PageSnapshot
): string | undefined {
  const parts = actions.map((action) => actionSignature(action, snapshot));
  // All or nothing: a turn holding one unidentifiable action cannot be compared,
  // and guessing at it is how a detector starts reporting false repeats.
  if (parts.length === 0 || parts.some((part) => part === undefined)) return undefined;
  return parts.join(" + ");
}

export interface Repetition {
  /** Consecutive turns that did exactly this. 1 means the first time. */
  readonly count: number;
  /** Say something to the model, because it has not noticed. */
  readonly warn: boolean;
  /** Stop. It was told, and it carried on. */
  readonly giveUp: boolean;
}

/**
 * Tracks what the last turn did, and how long it has been doing it.
 *
 * Deliberately consecutive rather than cumulative. Coming back to an action
 * later, having done something else in between, is ordinary work — a form filled
 * in two passes, a list clicked through. What is never ordinary is the same
 * thing four times with nothing else between.
 */
export class RepeatWatch {
  #last: string | undefined;
  #count = 0;

  /** Records this turn and reports whether it is a rut. */
  saw(signature: string | undefined): Repetition {
    if (signature === undefined) {
      // Unidentifiable, so it breaks the run rather than extending it: an
      // undetectable turn is not evidence of repeating.
      this.#last = undefined;
      this.#count = 0;
      return { count: 0, warn: false, giveUp: false };
    }

    this.#count = signature === this.#last ? this.#count + 1 : 1;
    this.#last = signature;

    return {
      count: this.#count,
      warn: this.#count === REPEATING_AFTER,
      giveUp: this.#count >= REPEATING_LIMIT,
    };
  }

  /** Anything genuinely different resets it — including a redirect. */
  reset(): void {
    this.#last = undefined;
    this.#count = 0;
  }
}

/**
 * What the model is told when it has not noticed.
 *
 * Blunt, specific, and it names the thing rather than describing a mood.
 * "Something is wrong" produced a reworded version of the same click; naming the
 * action and the count leaves nowhere to go except somewhere else.
 */
export function repetitionWarning(signature: string, count: number): string {
  return (
    `You have now done exactly this ${String(count)} times in a row — ${signature} — and the ` +
    `page is no closer to the goal. It is not going to work the ${String(count + 1)}th time. ` +
    `Do something materially different: a different element, a different route to the same ` +
    `end, or a different site. If there is nothing else to try, say what is blocking you and ` +
    `stop.`
  );
}
