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
import type { BrowserExecutor } from "@nell/aegis";
import type { BrowserProvider, PageSnapshot } from "@nell/browser";
import type { AccessScope } from "@nell/shared";

export interface LoopDeps {
  readonly provider: BrowserProvider;
  readonly executor: BrowserExecutor;
  readonly model: ModelProvider;
  readonly modelId: string;
}

export interface LoopRequest {
  readonly scope: AccessScope;
  readonly sessionId: string;
  readonly objective: string;
  readonly maxSteps?: number;
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
  | { readonly ok: true; readonly steps: number; readonly summary: string }
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

  for (let step = 1; step <= limit; step += 1) {
    // A fresh look every time. The previous plan's refs died the moment this
    // ran, which is the point — a stale plan cannot half-apply.
    const snapshot = await deps.provider.snapshot(request.scope, request.sessionId);

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
    });

    if (!planned.ok) {
      return { ok: false, steps: step, reason: explainPlanFailure(planned.failure) };
    }

    request.onStep?.(planned.plan.reasoning);
    history.push(planned.plan.reasoning);

    if (planned.plan.done) {
      return { ok: true, steps: step, summary: planned.plan.reasoning };
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

    const outcome = await deps.executor.execute(request.scope, request.sessionId, {
      kind: "targeted",
      actions: planned.plan.actions,
    });

    if (!outcome.ok) {
      // A refusal is the policy engine working, and it is the user's business.
      return { ok: false, steps: step, reason: outcome.reason };
    }
  }

  return {
    ok: false,
    steps: limit,
    reason: `I did not finish within ${String(limit)} steps, so I stopped rather than keep going.`,
  };
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
