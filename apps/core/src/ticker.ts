/**
 * The heartbeat.
 *
 * Once a minute, claim whatever is due and run it. This is the whole of
 * proactivity: without it Nell only ever acts when spoken to, which is the
 * difference between an assistant and a command line.
 *
 * It runs beside the Telegram poll rather than inside it. The poll spends most
 * of its life blocked on a 25-second long poll, and hanging scheduled work off
 * that would mean a 6am briefing arriving whenever the next message happened to
 * come in — which, overnight, is never.
 *
 * A tick never throws. Whatever goes wrong — the database is down, a model is
 * rate-limited, a page has changed shape — the process must still be here for
 * the next one. A scheduler that dies on its first bad night is worse than no
 * scheduler, because the user stops checking.
 */

import type { BrowserExecutor } from "@nell/aegis";
import { assist, type ClientTool, type ModelProvider } from "@nell/agent";
import type { BrowserProvider } from "@nell/browser";
import type { SearchProvider } from "@nell/integrations";
import type { AccessScope } from "@nell/shared";
import type { Pool } from "pg";
import { runLoop } from "./agent-loop.js";
import { withWorkspace } from "./db.js";
import { claimDue, completeRun, FOLLOW_UP, recordIfNew, type Schedule } from "./schedules.js";
import { z } from "zod";
import { verdictOn } from "./follow-up.js";
import type { WorkspaceSessions } from "./workspace-session.js";

/** What `createFollowUp` wrote on the row, read back here. */
const followUpConfig = z.object({ kind: z.literal("follow-up"), original: z.string() });

export interface TickerDeps {
  readonly pool: Pool;
  readonly browser: BrowserProvider;
  readonly sessions: WorkspaceSessions;
  readonly executor: BrowserExecutor;
  readonly model: ModelProvider;
  readonly modelId: string;
  readonly search?: SearchProvider;
  /** Deliver a result. Separate from the channel so a tick has no idea it is Telegram. */
  readonly send: (threadRef: string, text: string) => Promise<unknown>;
  /**
   * The clock, injected.
   *
   * Not decoration: the reschedule used `Date.now()` directly while `tickOnce`
   * took a `now` argument, so a test could advance time for the claim and not
   * for the reschedule. The result was a test that asserted a repeat stayed
   * quiet and was in fact measuring a tick that never ran at all — passing,
   * green, and testing nothing. One clock, or the two disagree.
   */
  readonly clock?: () => number;
  readonly log?: (line: string) => void;
  /**
   * Key and model for the assist path, when this install has one.
   *
   * A follow-up looks something up and compares it to what was said; it drives
   * no page and needs no session. Running it through the browser loop — which is
   * what every scheduled thing did before, because that was the only runner —
   * would open a browser to read a forecast.
   */
  readonly assistKey?: string;
  readonly assistModel?: string;
  readonly assistBaseUrl?: string;
  readonly tools?: readonly ClientTool[];
}

export const TICK_MS = 60_000;

/**
 * One pass over one workspace.
 *
 * Returns what it ran, so a test can assert on it and a caller can log it.
 * Sequential rather than concurrent: a workspace has one browser, so two
 * schedules firing at the same minute have to take turns anyway, and pretending
 * otherwise would just move the contention somewhere less obvious.
 */
export async function tickOnce(
  deps: TickerDeps,
  scope: AccessScope,
  now: number = (deps.clock ?? Date.now)()
): Promise<readonly string[]> {
  const due = await withWorkspace(deps.pool, scope, (client) => claimDue(client, scope, now));
  const ran: string[] = [];

  for (const schedule of due) {
    try {
      await runSchedule(deps, scope, schedule);
      ran.push(schedule.id);
    } catch (error) {
      deps.log?.(`schedule ${schedule.label} failed: ${describe(error)}`);
    } finally {
      /**
       * Always reschedule, even after a failure.
       *
       * The alternative leaves the row leased until the lease expires and then
       * retries immediately — so a schedule whose site is down turns into a
       * retry loop every five minutes rather than a task that failed once and
       * will try again tomorrow.
       */
      await withWorkspace(deps.pool, scope, (client) =>
        completeRun(client, scope, schedule.id, (deps.clock ?? Date.now)(), schedule.everyMinutes)
      ).catch(() => undefined);
    }
  }

  return ran;
}

async function runSchedule(
  deps: TickerDeps,
  scope: AccessScope,
  schedule: Schedule
): Promise<void> {
  if (schedule.checkType === FOLLOW_UP) {
    await runFollowUp(deps, scope, schedule);
    return;
  }

  deps.log?.(`running schedule: ${schedule.label}`);

  const session = await deps.sessions.acquire(scope);
  const outcome = await runLoop(
    {
      provider: deps.browser,
      executor: deps.executor,
      model: deps.model,
      modelId: deps.modelId,
      ...(deps.search ? { search: deps.search } : {}),
    },
    { scope, sessionId: session.id, objective: schedule.prompt }
  );

  if (!schedule.threadRef) return;

  if (!outcome.ok) {
    // Told, not hidden. A briefing that silently stops arriving is indis-
    // tinguishable from one that had nothing to say, and the user cannot tell
    // which without asking.
    await deps.send(schedule.threadRef, `${schedule.label}: ${outcome.reason}`);
    return;
  }

  const body = outcome.answer || outcome.summary;

  /**
   * Don't send the same thing twice.
   *
   * A daily scan that finds yesterday's page is not news, and repeating it
   * teaches the user to ignore the notification — which costs them the one that
   * matters. The database decides, via a uniqueness constraint, so two ticks
   * racing cannot both conclude the content is new.
   */
  const isNew = await withWorkspace(deps.pool, scope, (client) =>
    recordIfNew(client, scope, schedule.id, body)
  );
  if (!isNew) {
    deps.log?.(`${schedule.label}: unchanged, saying nothing`);
    return;
  }

  await deps.send(schedule.threadRef, `${schedule.label}\n\n${body}`);
}

/**
 * Look again at something already answered, and speak only if it changed.
 *
 * The whole value is in the second half. A follow-up that arrives to say "still
 * fine" is the notification that teaches someone to stop reading them — which
 * costs them the one that mattered. So the default is silence, the bar for
 * speaking is that the *advice* has changed rather than that the *conditions*
 * have, and what gets sent corrects the specific thing that was said rather than
 * restating the situation.
 */
async function runFollowUp(
  deps: TickerDeps,
  scope: AccessScope,
  schedule: Schedule
): Promise<void> {
  deps.log?.(`following up: ${schedule.label}`);

  if (!schedule.threadRef || !deps.assistKey) return;

  const config = followUpConfig.safeParse(schedule.config);
  if (!config.success) {
    // Written by `createFollowUp` and read here; a row that does not parse is a
    // bug rather than a user's problem, and there is nothing useful to send.
    deps.log?.(`follow-up ${schedule.label}: unreadable config`);
    return;
  }

  const looked = await assist({
    apiKey: deps.assistKey,
    model: deps.assistModel ?? "anthropic/claude-sonnet-4-5",
    ...(deps.assistBaseUrl ? { baseUrl: deps.assistBaseUrl } : {}),
    system:
      "Check the current state of the thing described. Report only what you find — do not " +
      "give advice and do not write a message to anybody. Be specific and quantitative.",
    prompt: schedule.prompt,
    search: true,
    code: false,
    ...(deps.tools?.length ? { tools: deps.tools } : {}),
  });

  if (!looked.ok) {
    /**
     * A failed look is silent, and that is deliberate.
     *
     * A recurring briefing that stops arriving is reported, because its absence
     * is indistinguishable from having nothing to say and the user is expecting
     * it. Nobody is expecting this one — it was never promised — so "I tried to
     * check something you didn't ask me to check and it didn't work" is noise.
     */
    deps.log?.(`follow-up ${schedule.label} failed: ${looked.reason}`);
    return;
  }

  const message = await verdictOn(config.data.original, looked.text, {
    provider: deps.model,
    model: deps.modelId,
  });

  if (!message) {
    deps.log?.(`follow-up ${schedule.label}: advice still stands, saying nothing`);
    return;
  }

  await deps.send(schedule.threadRef, message);
}

/**
 * Tick until stopped.
 *
 * The interval is measured from the *end* of the previous tick, so a tick that
 * takes longer than the interval cannot start overlapping with itself — which
 * for work that drives a single shared browser would mean two tasks fighting
 * over one page.
 */
export async function runTicker(
  deps: TickerDeps,
  scopes: readonly AccessScope[],
  signal?: AbortSignal
): Promise<void> {
  while (!signal?.aborted) {
    for (const scope of scopes) {
      if (signal?.aborted) break;
      await tickOnce(deps, scope).catch((error: unknown) => {
        deps.log?.(`tick failed: ${describe(error)}`);
        return [];
      });
    }

    await sleep(TICK_MS, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] || error.message : "unknown";
}
