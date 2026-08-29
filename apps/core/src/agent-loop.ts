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

import { explainPlanFailure, planFromScreen, planNext, type ModelProvider } from "@nell/agent";
import { humanise } from "./failure.js";
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
  /** Injected so a stall can be tested without waiting five minutes. */
  readonly clock?: () => number;
}

export interface LoopRequest {
  readonly scope: AccessScope;
  readonly sessionId: string;
  readonly objective: string;
  /** A hard backstop on model calls. The real bound is `stallMs`. */
  readonly maxSteps?: number;
  /** How long without progress before giving up. Defaults to `STALL_MS`. */
  readonly stallMs?: number;
  /**
   * What Nell knows about this user, already rendered. Empty when it knows
   * nothing, which is the state every task was in before tier-1 memory had a
   * database under it.
   */
  readonly profile?: string;
  /** Called after each step, so a user can watch rather than wait in silence. */
  readonly onStep?: (note: string) => void;
  /** Technical detail for the operator's log. Never reaches the user. */
  readonly onDiagnostic?: (note: string) => void;
  /** Drains anything the user has said since the task started. */
  readonly steering?: () => readonly string[];
  /** Aborts the task between steps, because the user asked it to stop. */
  readonly signal?: AbortSignal;
}

/**
 * How long a task may make no progress before it is abandoned.
 *
 * The bound that replaced a step count, and the change is not cosmetic. A step
 * limit asks "how much work is reasonable?" and answers with a number picked in
 * advance; the question that actually matters is "is this getting anywhere?",
 * and only the run can answer it. Twelve steps was a guess, and watching a real
 * booking disproved it — the agent searched, found the cinema, opened the film,
 * chose the 10pm showing, selected two tickets and reached checkout, then hit
 * the ceiling one step from the approval it was meant to stop at. Every step had
 * been necessary. The limit was cutting off correct work.
 *
 * So: progress buys time, and nothing else does.
 */
export const STALL_MS = 5 * 60 * 1000;

/**
 * What counts as progress.
 *
 * The page changed, a search returned, or the agent moved to a different page —
 * anything that alters what it is working from. Deliberately *not* "an action
 * succeeded": clicking a button that does nothing succeeds, and an agent doing
 * that forever is the exact failure this bounds.
 */

/** Identical pages in a row before the structured sense is considered exhausted. */
export const STUCK_AFTER = 3;

/**
 * Failed actions in a row before the structured sense is considered exhausted.
 *
 * Consecutive, not total: a page that refuses one click and then works is
 * ordinary, and a task should not carry a grudge from step two into step nine.
 */
export const MAX_ACTION_FAILURES = 3;

/**
 * A backstop, not a budget.
 *
 * With progress as the real bound this should never be reached — five minutes of
 * genuine stalling ends a task long before a hundred steps do. It exists because
 * "unbounded" and "bounded by something that could itself fail" are different
 * claims, and every step is a model call somebody pays for.
 */
export const HARD_STEP_CAP = 100;

/**
 * Malformed plans in a row before giving up.
 *
 * A model that proposes an action outside the vocabulary has made a correctable
 * mistake — told what was wrong, it almost always fixes it next turn. A model
 * that cannot produce a valid plan three times running is not going to.
 */
export const MAX_BAD_PLANS = 3;

/**
 * Times the agent is sent back to finish before its answer is accepted anyway.
 *
 * A model that still reports open items after three attempts is usually telling
 * us they cannot be got — the flight prices are behind a login, the venue does
 * not publish times. Holding out past that trades a partial answer for none, and
 * a partial answer is what the user would rather have.
 */
export const MAX_FINISH_REFUSALS = 3;

/**
 * Consecutive failures to read the page before giving up on the session.
 *
 * Higher than the action limit because the common cause is transient — a page
 * mid-navigation, which the next look resolves. Past that it is a browser that
 * has gone, and no amount of waiting brings one back.
 */
export const MAX_UNREADABLE = 4;

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
      /**
       * The task stopped at a payment and needs a person to say yes.
       *
       * Distinct from a failure, and the caller must treat it as such: reporting
       * "that didn't work" when the truth is "I stopped where the money starts"
       * describes the safety feature as a fault.
       */
      readonly needsApproval?: boolean;
      /**
       * The technical cause, for the log. Never sent to the user — the whole
       * point of `reason` is that it is written for a person.
       */
      readonly detail?: string;
    };

/**
 * Run until the objective is met, the budget runs out, or nothing is changing.
 *
 * Every failure path reports how many steps it took, because "it did not work"
 * and "it did not work after eleven attempts" call for different responses from
 * whoever reads it.
 */
export async function runLoop(deps: LoopDeps, request: LoopRequest): Promise<LoopOutcome> {
  const cap = request.maxSteps ?? HARD_STEP_CAP;
  const stallAfter = request.stallMs ?? STALL_MS;
  const clock = deps.clock ?? Date.now;
  /** Reset by anything that changes what the agent is working from. */
  let lastProgressAt = clock();
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
  /** Reset by any step that works, so a wobble mid-task does not count toward a wall. */
  let consecutiveFailures = 0;
  /** Every page state this task has been in. Returning to one is not progress. */
  const seen = new Set<string>();
  /**
   * Malformed plans in a row. Reset by any plan that validates.
   *
   * An object rather than a number because the looking turn shares it, and a
   * count that resets when the agent changes sense is not counting the thing
   * that matters.
   */
  const badPlanCounter = { count: 0 };
  /** Parts of the request the last turn said were still open. */
  let outstanding: readonly string[] = [];
  /** Things the user has said since. Trusted, and they amend the objective. */
  const instructions: string[] = [];
  /** Consecutive failures to read the page at all. Reset by any successful look. */
  let unreadable = 0;
  /** Times the agent has been sent back to finish the job. */
  let finishRefusals = 0;
  /**
   * Sites that would not load.
   *
   * Watched live: a trip-planning task tried the same travel site three times
   * and a second one twice, every attempt failing identically with an HTTP/2
   * protocol error, and spent most of its budget doing it. Nothing remembered
   * that a host was dead, so nothing stopped it going back.
   */
  const deadHosts = new Set<string>();
  /** Once the structured sense has stalled, the rest of the task is driven by eye. */
  let looking = false;

  for (let step = 1; step <= cap; step += 1) {
    if (request.signal?.aborted) {
      return {
        ok: false,
        steps: step,
        reason: partial ? `Stopped.\n\nWhat I had so far:\n\n${partial}` : "Stopped.",
      };
    }

    /**
     * What the user has said since this started.
     *
     * The difference between an assistant and a form submission. A task now runs
     * for minutes, and watching it head somewhere wrong with no way to say "not
     * there, try BookMyShow" or "it is 2026, not 2024" is the most obvious thing
     * missing from a long task.
     *
     * Taken before the page is read, so a correction lands before another turn
     * is spent going the wrong way. Kept apart from `history` because these are
     * not a record of what was tried — they are the objective, amended, and the
     * planner is told to treat them as outranking it.
     *
     * Trusted, unlike everything else that arrives mid-task: this came from the
     * user, not from a page, which is exactly why it may redirect the objective
     * when nothing on a page ever may.
     */
    const said = request.steering?.() ?? [];
    if (said.length > 0) {
      instructions.push(...said);
      request.onDiagnostic?.(`steered: ${said.join(" | ")}`);
      // A new instruction is new information, so the task has not stalled.
      lastProgressAt = clock();
    }

    /**
     * The real bound: five minutes of getting nowhere.
     *
     * Checked before the work rather than after, so a task that has already
     * stalled does not buy one more model call on its way out.
     */
    if (clock() - lastProgressAt > stallAfter) {
      const minutes = String(Math.round(stallAfter / 60_000));
      const stalled = `I stopped after ${minutes} minutes without getting anywhere on this.`;
      return {
        ok: false,
        steps: step,
        stuck: true,
        reason: partial ? `${stalled}\n\nWhat I had so far:\n\n${partial}` : stalled,
      };
    }

    /**
     * A fresh look every time. The previous plan's refs died the moment this
     * ran, which is the point — a stale plan cannot half-apply.
     *
     * Guarded, because looking can fail: pressing Enter starts a navigation, and
     * a snapshot taken while it is in flight throws "Execution context was
     * destroyed". That is not a broken task, it is a page mid-move — but
     * uncaught it ended the process. Waiting a moment and looking again is the
     * whole fix, and it is what a person would do.
     */
    let snapshot;
    try {
      snapshot = await deps.provider.snapshot(request.scope, request.sessionId);
    } catch (error) {
      const failure = humanise(error);
      request.onDiagnostic?.(`could not read the page: ${failure.detail}`);
      unreadable += 1;

      /**
       * Fatal after a few, and deliberately not escalated to looking.
       *
       * A single failure is a page mid-navigation and waiting fixes it. Several
       * in a row means the session cannot be read at all, and vision is no
       * escape from that — a screenshot comes from the same session. Continuing
       * would sleep-and-retry until the stall timer fired five minutes later,
       * which is a long time to spend on a browser that is already gone.
       */
      if (unreadable >= MAX_UNREADABLE) {
        return { ok: false, steps: step, reason: failure.message, detail: failure.detail };
      }

      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }

    unreadable = 0;

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

    /**
     * Progress is a page it has not been on before — not merely a page that
     * changed.
     *
     * The distinction is the whole bound. Watched live: the agent bounced
     * between a cinema's home page and its search results for nearly three
     * minutes — home, search, home, search — and every single turn "changed the
     * page", so nothing ever looked stuck. It was moving and getting nowhere,
     * which is what a loop is.
     *
     * Revisiting is therefore silent: only somewhere new resets the clock. An
     * agent going round in circles now runs out of time exactly as if it had
     * been standing still, because it had been.
     */
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      lastProgressAt = clock();
    }

    /**
     * The page stopped changing — so look at it instead.
     *
     * This used to end the task. It was the most common way a task died, and it
     * was usually a perception failure rather than a real dead end: the
     * structured sense collects every element on the page regardless of the
     * viewport, so scrolling changes nothing it can see. The model would decide
     * it needed to scroll, scroll, observe no change, and be declared stuck —
     * three times over, on the same cinema listing, on three different days.
     *
     * A screenshot has no such blind spot. Escalating here rather than giving up
     * is also the right economics: the expensive sense is used only once the
     * cheap one has demonstrably stopped producing information, which is the
     * only moment its cost is clearly worth paying.
     */
    if ((unchanged >= STUCK_AFTER || consecutiveFailures >= MAX_ACTION_FAILURES) && !looking) {
      looking = true;
      unchanged = 0;
      consecutiveFailures = 0;
      previousFingerprint = "";
      request.onDiagnostic?.("structured sense stalled; switching to vision");
      history.push(
        "Reading the page structurally stopped telling me anything new, so I am looking at the screen."
      );
    }

    if (looking) {
      const seen = await lookAndAct(deps, request, {
        history,
        step,
        searched,
        bad: badPlanCounter,
        ...(request.profile ? { profile: request.profile } : {}),
      });
      if (seen.done) return seen.outcome;
      if (seen.answer) partial = seen.answer;
      continue;
    }

    const planned = await planNext({
      provider: deps.model,
      model: deps.modelId,
      objective: request.objective,
      snapshot,
      history,
      findings,
      outstanding,
      instructions,
      ...(request.profile ? { profile: request.profile } : {}),
    });

    if (!planned.ok) {
      request.onDiagnostic?.(explainPlanFailure(planned.failure));
      badPlanCounter.count += 1;

      /**
       * A malformed plan is a correctable mistake, not the end of a task.
       *
       * Watched live: asked to plan a trip, the model proposed an action outside
       * the vocabulary, and the task ended there — four steps in, on the first
       * slip, having done nothing wrong that another turn could not fix. The
       * action-failure path had already learned this lesson; the plan-failure
       * path next to it had not.
       *
       * The model is told what it got wrong, because it cannot see the
       * validator's complaint otherwise and will otherwise make the same
       * proposal again. `reason` here is the schema's own message — safe to
       * show a model, never shown to the user.
       */
      if (badPlanCounter.count < MAX_BAD_PLANS) {
        history.push(
          planned.failure.kind === "provider"
            ? "That attempt did not come back. Try again."
            : `That plan was rejected: ${planned.failure.reason} Use only the actions given.`
        );
        continue;
      }

      // `explainPlanFailure` interpolates the provider's own words — useful in a
      // terminal, meaningless in a chat message — so the user gets the
      // classified version and the log keeps the rest.
      const failure = humanise(new Error(planned.failure.reason));
      return { ok: false, steps: step, reason: failure.message, detail: failure.detail };
    }

    badPlanCounter.count = 0;

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
      // Knowing something new is progress, even though the page has not moved.
      lastProgressAt = clock();

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

    outstanding = planned.plan.outstanding;

    if (planned.plan.done) {
      /**
       * Finishing is refused while parts of the request are unanswered.
       *
       * A request is often several questions wearing one sentence — "flights,
       * stay, places to visit, activities" is four — and a model asked whether
       * it is done will say yes once it has something. Asked to plan a trip, it
       * read a single package listing and called that the plan, having never
       * looked at a flight.
       *
       * Enforced here rather than asked for in the prompt, because the model
       * owns both the checklist and the claim to be finished, and only one of
       * those can be checked. `finishRefusals` bounds it: a model that insists
       * three times is telling us the remaining items cannot be got, and holding
       * out for them would trade a partial answer for none.
       */
      if (outstanding.length > 0 && finishRefusals < MAX_FINISH_REFUSALS) {
        finishRefusals += 1;
        request.onDiagnostic?.(`finish refused; still open: ${outstanding.join("; ")}`);
        history.push(
          `Not finished — still unanswered: ${outstanding.join("; ")}. ` +
            `Go and find those before answering.`
        );
        continue;
      }

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
     * The executor returns an outcome when policy says no. The driver underneath
     * *throws*: an element vanished mid-batch, a click waited thirty seconds for
     * something that never appeared, a navigation stalled.
     *
     * This used to return, ending the task on the first such throw — under a
     * comment claiming the recovery was "the next iteration takes a fresh
     * snapshot", which the code then did not do. A single flaky click killed a
     * task that was one fresh look away from working, and the user got
     * `locator.click: Timeout 30000ms exceeded` for their trouble.
     *
     * Now it *is* the next iteration. The failure is written into history so the
     * model knows the thing it reached for was not there, and the loop takes a
     * new snapshot — which is genuinely the right recovery, because a page that
     * refused an action is a page that has moved.
     *
     * Bounded, because a page that fails every action is not going to start
     * working: a few consecutive failures with no progress in between is a wall,
     * not a wobble.
     */
    /**
     * Refuse to go back to a site that would not load.
     *
     * Telling the model was not enough — it had decided that site was the right
     * one, and a note in the history does not outweigh that. So the retry is
     * prevented rather than discouraged: three attempts at one dead host and two
     * at another consumed most of a task's budget, every one failing the same
     * way within a second.
     */
    const revisit = planned.plan.actions.find(
      (action) => action.action === "goto" && deadHosts.has(hostOf(action.url))
    );
    if (revisit && revisit.action === "goto") {
      history.push(
        `${hostOf(revisit.url)} already refused to load twice. It will not work. ` +
          `Find the answer somewhere else.`
      );
      continue;
    }

    let outcome;
    try {
      outcome = await deps.executor.execute(request.scope, request.sessionId, {
        kind: "targeted",
        actions: planned.plan.actions,
      });
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const failure = humanise(error);
      request.onDiagnostic?.(`step ${String(step)} failed: ${failure.detail}`);

      /**
       * A page that refuses everything is not a reason to stop — it is a reason
       * to look at it. Ending here was throwing away the second sense at exactly
       * the moment it was most likely to help: a click that times out three
       * times usually means the element is not where the accessibility tree says
       * it is, which is precisely what a screenshot settles.
       *
       * Once already looking, repeated failure is real, and the stall clock ends
       * it rather than a counter.
       */
      if (consecutiveFailures >= MAX_ACTION_FAILURES && looking) {
        return { ok: false, steps: step, reason: failure.message, detail: failure.detail };
      }

      /**
       * Told plainly, so the model tries something else rather than the same
       * element again. It cannot see the exception; this is all it gets.
       *
       * A navigation failure is named by host, because "that did not work" does
       * not stop a model going back to the same dead site — and it will, having
       * decided that site was the right one.
       */
      const dead = hostFromError(error);
      if (dead) deadHosts.add(dead);

      history.push(
        dead
          ? `${dead} will not load — it is not going to start. Use a different site.`
          : "That last step did not work — the element was not there, or the page moved. " +
              "Look at the page again and try a different way."
      );
      continue;
    }

    if (!outcome.ok) {
      // A refusal is the policy engine working, and it is the user's business.
      return {
        ok: false,
        steps: step,
        reason: outcome.reason,
        ...(outcome.needsApproval ? { needsApproval: true } : {}),
      };
    }
  }

  const capped =
    "I have been at this a long time without finishing, so I stopped rather than keep going.";

  return {
    ok: false,
    steps: cap,
    reason: partial ? `${capped}\n\nWhat I had so far:\n\n${partial}` : capped,
  };
}

interface LookState {
  readonly history: string[];
  readonly step: number;
  readonly profile?: string;
  /** Shared with the structured turn, so a query is never paid for twice. */
  readonly searched: Set<string>;
  /** Shared, mutable: malformed plans in a row, across both senses. */
  readonly bad: { count: number };
}

interface LookResult {
  readonly done: boolean;
  readonly outcome: LoopOutcome;
  readonly answer?: string;
}

/**
 * One turn of the looking sense.
 *
 * Take a picture, ask what to do, do it. The shape deliberately mirrors the
 * structured turn above — same bounds, same chokepoint, same treatment of a
 * refusal — because the guarantee this architecture makes is that *how the agent
 * sees* has no bearing on *what it is allowed to do*. Instinct booked a table
 * with a £200 cancellation fee when asked only to find one; that is an
 * action-selection failure and no amount of perception fixes it, so the gate
 * that prevents it sits on the far side of both senses.
 */
async function lookAndAct(
  deps: LoopDeps,
  request: LoopRequest,
  state: LookState
): Promise<LookResult> {
  /**
   * The driver throws here too, and this did not catch it.
   *
   * Found by running it: a screenshot timed out waiting for fonts on a heavy
   * page and the exception went all the way up, ending the process rather than
   * the task. The structured turn had guarded this from the start; the looking
   * turn was written later and inherited the shape without the guard.
   */
  let shot;
  try {
    shot = await deps.executor.execute(request.scope, request.sessionId, {
      kind: "computer",
      actions: [{ action: "screenshot" }],
    });
  } catch (error) {
    const failure = humanise(error);
    request.onDiagnostic?.(`vision: could not capture — ${failure.detail}`);
    return {
      done: true,
      outcome: { ok: false, steps: state.step, reason: failure.message, detail: failure.detail },
    };
  }

  if (!shot.ok) {
    return { done: true, outcome: { ok: false, steps: state.step, reason: shot.reason } };
  }
  if (!shot.result?.screenshot) {
    // Nothing to look at is not something to keep trying — a session that cannot
    // produce a picture will not start.
    return {
      done: true,
      outcome: {
        ok: false,
        steps: state.step,
        reason: "I could not get a picture of the page to work from.",
      },
    };
  }

  const space = deps.provider.coordinateSpace();
  const planned = await planFromScreen({
    provider: deps.model,
    model: deps.modelId,
    objective: request.objective,
    screenshot: shot.result.screenshot,
    display: space.display,
    // The origin, not the full URL: it is what the driver reports, and for
    // orienting a model it is the part that matters.
    url: shot.result.currentOrigin,
    history: state.history,
    ...(state.profile ? { profile: state.profile } : {}),
  });

  if (!planned.ok) {
    request.onDiagnostic?.(`vision: ${planned.reason}`);
    state.bad.count += 1;

    /**
     * The same correction the structured turn got, which this one did not.
     *
     * A malformed plan is a correctable mistake: told what was wrong, the model
     * almost always fixes it next turn. Ending here threw away a task that had
     * spent three minutes genuinely researching flights and hotels, because the
     * last turn named an action that did not exist.
     *
     * That the fix landed on one of two identical code paths is the lesson: the
     * looking turn was written later and copied the shape without the guard,
     * twice now — once for driver exceptions, once for this.
     */
    if (state.bad.count < MAX_BAD_PLANS) {
      state.history.push(`That plan was rejected: ${planned.reason} Use only the actions listed.`);
      return { done: false, outcome: { ok: false, steps: state.step, reason: "" } };
    }

    const failure = humanise(new Error(planned.reason));
    return {
      done: true,
      outcome: { ok: false, steps: state.step, reason: failure.message, detail: failure.detail },
    };
  }

  state.bad.count = 0;

  request.onStep?.(planned.plan.reasoning);
  state.history.push(planned.plan.reasoning);

  /**
   * Leaving the page, which the looking sense cannot do by itself.
   *
   * Handled before the actions for the same reason a search is in the structured
   * turn: whatever was planned to click was planned against the page being left.
   * Navigation goes through the ordinary `goto`, so it meets the same validation
   * — http(s) only — as every other navigation in the system. The looking sense
   * gets a way out of a dead end, not a way around the gate.
   */
  if (planned.plan.navigate) {
    try {
      await deps.executor.execute(request.scope, request.sessionId, {
        kind: "targeted",
        actions: [{ action: "goto", url: planned.plan.navigate, waitUntil: "domcontentloaded" }],
      });
    } catch (error) {
      const failure = humanise(error);
      request.onDiagnostic?.(`vision navigate failed: ${failure.detail}`);
      const dead = hostFromError(error) ?? planned.plan.navigate;
      state.history.push(`${dead} will not load — it is not going to start. Use a different site.`);
    }
    return { done: false, outcome: { ok: false, steps: state.step, reason: "" } };
  }

  if (planned.plan.search && deps.search && !state.searched.has(planned.plan.search)) {
    state.searched.add(planned.plan.search);
    const results = renderFindings(
      await searchWeb({ query: planned.plan.search }, { provider: deps.search })
    );
    request.onStep?.(`Searching for "${planned.plan.search}".`);
    // Into history, because the looking sense reads history and has nowhere else
    // to put text it did not see on the screen.
    state.history.push(results);
    return { done: false, outcome: { ok: false, steps: state.step, reason: "" } };
  }

  if (planned.plan.done) {
    return {
      done: true,
      outcome: {
        ok: true,
        steps: state.step,
        summary: planned.plan.reasoning,
        answer: planned.plan.answer.trim(),
      },
    };
  }

  if (planned.plan.actions.length === 0) {
    return {
      done: true,
      outcome: {
        ok: false,
        steps: state.step,
        reason: "I could not work out what to do next on this page.",
      },
    };
  }

  let acted;
  try {
    acted = await deps.executor.execute(request.scope, request.sessionId, {
      kind: "computer",
      actions: planned.plan.actions,
    });
  } catch (error) {
    // Same treatment as the structured path: the page refused, so look again
    // rather than ending the task on one bad click.
    const failure = humanise(error);
    request.onDiagnostic?.(`vision step failed: ${failure.detail}`);
    state.history.push("That did not work — look again and try a different spot.");
    return { done: false, outcome: { ok: false, steps: state.step, reason: "" } };
  }

  if (!acted.ok) {
    // A refusal is the policy engine working, and it is the user's business.
    return {
      done: true,
      outcome: {
        ok: false,
        steps: state.step,
        reason: acted.reason,
        ...(acted.needsApproval ? { needsApproval: true } : {}),
      },
    };
  }

  return {
    done: false,
    outcome: { ok: false, steps: state.step, reason: "" },
    ...(planned.plan.answer.trim() ? { answer: planned.plan.answer.trim() } : {}),
  };
}

/** The host of a URL, or the URL itself when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

/**
 * The host a navigation error was about.
 *
 * Playwright puts the URL in the message — `page.goto: net::ERR_HTTP2_PROTOCOL_
 * ERROR at https://example.com/x`. Pulling the host out is what lets the agent
 * be told which site to stop trying, rather than being told, uselessly, that
 * something did not work.
 */
function hostFromError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /https?:\/\/[^\s)]+/u.exec(error.message);
  if (!match) return undefined;
  try {
    return new URL(match[0]).hostname.replace(/^www\./u, "");
  } catch {
    return undefined;
  }
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
