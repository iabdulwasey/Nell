/**
 * The loop.
 *
 * Look at the page, decide, act, look again, stop when done. Everything else in
 * this repository exists to make one turn of this safe; this is the thing that
 * turns it.
 *
 * Three bounds, and each exists because of a specific way agents fail:
 *
 * **A step limit**, because a model that cannot make progress will not notice.
 * It will try the same thing in slightly different words until something else
 * stops it, and "something else" should be a number rather than a bill.
 *
 * **A repetition check**, because the common failure is not wild behaviour but a
 * tight loop: click the same button, get the same page, click it again. Counting
 * steps catches that eventually; noticing the page did not change catches it
 * three steps in.
 *
 * **A fresh look after every batch.** The plan the model produced described the
 * page as it was. Once acted upon, that description is history — and every ref
 * in it is deliberately dead, so continuing on the old view fails loudly rather
 * than acting on a page that has moved.
 */

import { explainPlanFailure, planNext, type ModelProvider } from "@nell/agent";
import { renderFindings, searchWeb, type SearchProvider } from "@nell/integrations";
import type { BrowserExecutor } from "@nell/aegis";
import { detectBlock, explainBlock, type BrowserProvider, type PageSnapshot } from "@nell/browser";
import type { AccessScope } from "@nell/shared";

export interface LoopDeps {
  readonly provider: BrowserProvider;
  readonly executor: BrowserExecutor;
  readonly model: ModelProvider;
  readonly modelId: string;
  /**
   * Optional. Without one the agent still works — it just has to reach pages by
   * navigating, which is what search engines block.
   */
  readonly search?: SearchProvider;
}

export interface LoopRequest {
  readonly scope: AccessScope;
  readonly sessionId: string;
  readonly objective: string;
  readonly maxSteps?: number;
  /**
   * What Nell knows about this user, already rendered. Empty when it knows
   * nothing, which is the state every task was in before tier-1 memory had a
   * database under it.
   */
  readonly profile?: string;
  /** Called after each step, so a user can watch rather than wait in silence. */
  readonly onStep?: (note: string) => void;
}

/**
 * Enough to finish an ordinary booking, few enough that a stuck agent stops
 * being expensive quickly.
 */
export const MAX_STEPS = 12;

/** Identical pages in a row before concluding the agent is stuck rather than working. */
export const STUCK_AFTER = 3;

export type LoopOutcome =
  /**
   * `answer` is what the user asked for; `summary` is what the agent was doing.
   * Kept separate because a model that has only one field to fill will fill it
   * with the second, and the second is worthless to someone who cannot see the
   * screen. Empty `answer` is legitimate — "book the table" has an outcome and
   * no answer — so the caller falls back rather than treating it as a failure.
   */
  | {
      readonly ok: true;
      readonly steps: number;
      readonly summary: string;
      readonly answer: string;
    }
  | {
      readonly ok: false;
      readonly steps: number;
      readonly reason: string;
      readonly stuck?: boolean;
    };

/**
 * Run until the objective is met, the budget runs out, or nothing is changing.
 *
 * Every failure path reports how many steps it took, because "it did not work"
 * and "it did not work after eleven attempts" call for different responses from
 * whoever reads it.
 */
export async function runLoop(deps: LoopDeps, request: LoopRequest): Promise<LoopOutcome> {
  const limit = request.maxSteps ?? MAX_STEPS;
  const history: string[] = [];
  let unchanged = 0;
  let previousFingerprint = "";
  /**
   * The best answer seen so far, kept because running out of steps is not the
   * same as having found nothing. A model part-way through a list of flights has
   * genuinely useful half of one, and reporting only "I did not finish" throws
   * away work the user already paid for.
   */
  let partial = "";
  /**
   * Search results, kept apart from `history`.
   *
   * `history` is what the agent has tried; this is third-party text it has been
   * shown. Merging them would file attacker-authored snippets under the agent's
   * own account of its work, which is exactly the confusion the provenance
   * model exists to prevent — and the planner labels them differently for the
   * same reason.
   */
  const findings: string[] = [];
  /** Repeating a query buys nothing and is billed. */
  const searched = new Set<string>();

  for (let step = 1; step <= limit; step += 1) {
    // A fresh look every time. The previous plan's refs died the moment this
    // ran, which is the point — a stale plan cannot half-apply.
    const snapshot = await deps.provider.snapshot(request.scope, request.sessionId);

    /**
     * Stop at a wall rather than clicking at it.
     *
     * Checked before the model is asked anything, because a model asked "what do
     * I click next" will always find something to click — that is the question
     * it was given. Watched live: four sites in a row refused a headless
     * browser, each one was reported as "an access warning" the agent was
     * "proceeding past", and a whole step budget went on a button it had
     * invented. The page said, in a heading, that it had blocked us.
     *
     * Ending here converts an expensive nonsense answer into a cheap true one.
     */
    const block = detectBlock(snapshot);
    if (block.blocked) {
      return {
        ok: false,
        steps: step,
        reason: explainBlock(block, snapshot.url),
      };
    }

    const fingerprint = fingerprintOf(snapshot);
    unchanged = fingerprint === previousFingerprint ? unchanged + 1 : 0;
    previousFingerprint = fingerprint;

    if (unchanged >= STUCK_AFTER) {
      return {
        ok: false,
        steps: step,
        stuck: true,
        reason: "The page stopped changing, so I was repeating myself rather than making progress.",
      };
    }

    const planned = await planNext({
      provider: deps.model,
      model: deps.modelId,
      objective: request.objective,
      snapshot,
      history,
      findings,
      ...(request.profile ? { profile: request.profile } : {}),
    });

    if (!planned.ok) {
      return { ok: false, steps: step, reason: explainPlanFailure(planned.failure) };
    }

    request.onStep?.(planned.plan.reasoning);
    history.push(planned.plan.reasoning);
    if (planned.plan.answer.trim()) partial = planned.plan.answer.trim();

    /**
     * Search before acting, and hand the results to the next turn as context.
     *
     * They arrive as `untrusted` from `searchWeb`, which is not a formality:
     * search snippets are attacker-authored text reachable by anyone willing to
     * do SEO, and this is the same injection surface as email. The provenance
     * gate governs what a turn holding them may go on to do; here they are
     * simply what the planner reads next.
     *
     * A failed search is context, not an ending. Vendors rate-limit, and an
     * agent told "search failed" can still navigate somewhere sensible — which
     * is strictly better than killing a task that was three steps from done.
     */
    if (planned.plan.search && deps.search && !searched.has(planned.plan.search)) {
      searched.add(planned.plan.search);
      findings.push(
        renderFindings(await searchWeb({ query: planned.plan.search }, { provider: deps.search }))
      );
      request.onStep?.(`Searching for "${planned.plan.search}".`);

      /**
       * Re-plan rather than run this turn's actions.
       *
       * Those actions were chosen before the results existed, so running them is
       * the same stale-plan hazard the fresh snapshot above exists to prevent —
       * just with the model's own assumptions rather than the page's.
       *
       * The fingerprint is cleared with it: the page has not changed, but the
       * agent knows something it did not, and letting the stuck detector count
       * that as a wasted turn would abort a task that is making progress.
       */
      unchanged = 0;
      previousFingerprint = "";
      continue;
    }

    if (planned.plan.done) {
      return {
        ok: true,
        steps: step,
        summary: planned.plan.reasoning,
        answer: planned.plan.answer.trim(),
      };
    }
    if (planned.plan.actions.length === 0) {
      // Not done, nothing proposed. Treating this as success would report a
      // finished task that never happened.
      return {
        ok: false,
        steps: step,
        reason: "I could not work out what to do next on this page.",
      };
    }

    /**
     * A refusal is a value; a broken page is an exception.
     *
     * The executor returns an outcome when policy says no, but the driver
     * underneath throws — an element vanished mid-batch, a navigation timed out,
     * a selector was malformed. Uncaught, that ends the task with a Playwright
     * stack trace as the user-facing message ("locator.fill: SyntaxError:
     * Failed to execute 'querySelectorAll'…"), which tells them nothing and
     * reads like the assistant broke rather than the page did.
     *
     * Not retried here. A step that failed is a page that is no longer what the
     * plan assumed, and the next iteration takes a fresh snapshot anyway —
     * which is the recovery, and a better one than repeating a dead action.
     */
    let outcome;
    try {
      outcome = await deps.executor.execute(request.scope, request.sessionId, {
        kind: "targeted",
        actions: planned.plan.actions,
      });
    } catch (error) {
      return {
        ok: false,
        steps: step,
        reason: `That step did not work on the page: ${describeError(error)}`,
      };
    }

    if (!outcome.ok) {
      // A refusal is the policy engine working, and it is the user's business.
      return { ok: false, steps: step, reason: outcome.reason };
    }
  }

  const ranOut = `I did not finish within ${String(limit)} steps, so I stopped rather than keep going.`;

  return {
    ok: false,
    steps: limit,
    reason: partial ? `${ranOut}\n\nWhat I had so far:\n\n${partial}` : ranOut,
  };
}

/**
 * The first line of a driver error.
 *
 * Playwright appends a call log — every locator it tried, with timings — which
 * is genuinely useful in a terminal and is noise in a text message. The first
 * line carries what went wrong.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "something went wrong.";
  return (error.message.split("\n")[0] ?? error.message).trim();
}

/**
 * A cheap identity for "is this the same page".
 *
 * Roles and names rather than refs, because refs change on every snapshot by
 * design — fingerprinting them would say every page is new and the stuck check
 * would never fire. Values are included: a form being filled in is progress even
 * when the page's structure is identical.
 */
function fingerprintOf(snapshot: PageSnapshot): string {
  return [
    snapshot.url,
    ...snapshot.nodes.map((node) => `${node.role}|${node.name ?? ""}|${node.value ?? ""}`),
  ].join("\n");
}
