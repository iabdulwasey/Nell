/**
 * Nell, running.
 *
 * Reads Telegram, runs a task, replies. Every guarantee the rest of this
 * repository establishes has to survive being assembled here, so the ordering
 * below is the substance rather than plumbing:
 *
 *   a stranger is answered but cannot cause work
 *   a known user's message becomes a persisted task
 *   the agent looks, plans, acts through the policy chokepoint, looks again
 *   the workspace's browser stays open, because its logins are the asset
 *   the outcome is written down and reported back
 *
 * Deliberately a loop over one task at a time. Concurrency here would be easy to
 * add and would immediately need answers about which task owns the machine — and
 * the persistent-machine design says one workspace has one, so serialising is
 * the honest shape rather than a limitation to remove later.
 */

import { BrowserExecutor } from "@nell/aegis";
import { isBareReply, providerFor, type ModelProvider, type ProviderKeys } from "@nell/agent";
import type { BrowserProvider } from "@nell/browser";
import type { SearchProvider } from "@nell/integrations";
import { greeting } from "@nell/memory";
import { accessScopeForUser, type AccessScope } from "@nell/shared";
import type { Pool } from "pg";
import { runLoop, type LoopOutcome } from "./agent-loop.js";
import { withWorkspace } from "./db.js";
import { humanise } from "./failure.js";
import { resolvePlace, reverseGeocode } from "./geocode.js";
import { park, peek, unpark } from "./pending-task.js";
import {
  LOCATION_KEY,
  locationOf,
  needsLocation,
  profileForPrompt,
  readProfile,
  remember,
} from "./profile.js";
import { describeSchedule, parseScheduleRequest } from "./schedule-request.js";
import { cancelAll, createSchedule, listSchedules } from "./schedules.js";
import { pollOnce, replyToStranger, sendMessage, type InboundMessage } from "./telegram-poll.js";
import type { WorkspaceSessions } from "./workspace-session.js";

export interface NellOptions {
  readonly pool: Pool;
  readonly browser: BrowserProvider;
  /** The workspace's long-lived browser. Outlives any one task, by design. */
  readonly sessions: WorkspaceSessions;
  /**
   * Optional. Without it the agent must reach every page by navigating, and
   * search engines serve automated browsers a captcha — so research tasks fail
   * on the way to the results rather than on the results.
   */
  readonly search?: SearchProvider;
  readonly keys: ProviderKeys;
  readonly modelId: string;
  readonly telegramToken: string;
  /** Telegram sender id → user id. Everyone else is a stranger. */
  readonly knownSenders: ReadonlyMap<string, string>;
  readonly log?: (line: string) => void;
}

/**
 * Handle one message.
 *
 * Exported separately from the polling loop so it can be tested without a
 * network: the interesting behaviour is what happens to a message, not how it
 * arrived.
 */
export async function handleMessage(
  options: NellOptions,
  message: InboundMessage
): Promise<LoopOutcome | undefined> {
  const log = options.log ?? (() => undefined);
  const reply = (text: string) =>
    sendMessage({ token: options.telegramToken, chatId: message.envelope.threadRef, text });

  // Answered, and given nothing. Silence from a bot that is plainly online reads
  // as broken and invites retrying.
  if (message.provenance !== "user" || !message.userId) {
    log(`stranger ${message.envelope.senderRef}: ${message.envelope.text.slice(0, 60)}`);
    await reply(replyToStranger());
    return undefined;
  }

  const scope = accessScopeForUser(message.userId);
  const objective = message.envelope.text.trim();
  const taskId = message.idempotencyKey;

  /**
   * Commands are conversation, not work.
   *
   * Without this the first thing anyone ever sends — `/start`, which Telegram
   * puts behind the button that opens a new bot — becomes an objective, and the
   * agent opens a browser to find out what "/start" is. A first impression of
   * the assistant confidently doing something absurd.
   */
  if (objective.startsWith("/")) {
    const command = objective.split(/\s/u)[0]?.toLowerCase();
    if (command === "/start" || command === "/help") {
      await reply(greeting());
    } else if (command === "/schedules") {
      // Anything that acts on its own has to be inspectable, or the user is
      // left guessing why they got a message at six in the morning.
      await ensureWorkspace(options, scope);
      const existing = await withWorkspace(options.pool, scope, (client) =>
        listSchedules(client, scope)
      );
      await reply(
        existing.length === 0
          ? "Nothing scheduled. Ask me to do something every day and I'll set it up."
          : [
              "What I'm doing on a schedule:",
              ...existing.map((row) => `• ${row.label} — ${row.prompt}`),
              "",
              "Send /stop to cancel them all.",
            ].join("\n")
      );
    } else if (command === "/stop") {
      await ensureWorkspace(options, scope);
      const stopped = await withWorkspace(options.pool, scope, (client) =>
        cancelAll(client, scope)
      );
      await reply(
        stopped === 0
          ? "Nothing was scheduled."
          : `Stopped ${String(stopped)}. Nothing is scheduled now.`
      );
    } else {
      await reply("I do not know that command. Just tell me what you need in your own words.");
    }
    return undefined;
  }

  /**
   * "Ok" is not a task.
   *
   * Observed live: a bare "Ok" became an objective, a browser opened, and the
   * agent reported that "Ok" did not specify an action — having spent a model
   * call and a page load to say so. `isBareReply` already recognises these
   * because the steering router needs them; with no task waiting on an answer
   * there is nothing for one to confirm, so it is small talk.
   *
   * Once tasks can block on a question this is where the reply gets routed to
   * the task that asked it, which is what `routeMessage` is for.
   */
  if (isBareReply(objective)) {
    await reply("Anything you need?");
    return undefined;
  }

  const resolved = providerFor(options.modelId, options.keys);
  if (!resolved.ok) {
    await reply("I have no model configured, so I cannot do anything yet.");
    return undefined;
  }

  await ensureWorkspace(options, scope);

  /**
   * A shared pin is an answer, whatever was asked.
   *
   * Unambiguous in a way typed text never is, and one tap on the phone the user
   * is already holding — so it is taken before anything else looks at the
   * message. The coordinates become a place name because "17.38, 78.48" is not
   * something a cinema listing will match.
   */
  if (message.sharedLocation) {
    const place =
      (await reverseGeocode(message.sharedLocation.latitude, message.sharedLocation.longitude)) ??
      message.sharedLocation.label;

    if (!place) {
      await reply("I couldn't work out where that is. What's the city?");
      return undefined;
    }

    await withWorkspace(options.pool, scope, (client) =>
      remember(client, scope, {
        key: LOCATION_KEY,
        value: place,
        category: "travel",
        provenance: "user",
      })
    );
    await reply(`${place} — noted. I'll use that when you say "near me".`);
    return resumeParked(options, message, scope, resolved.provider);
  }

  /**
   * A task is waiting on a location, and this might be it.
   *
   * The message is only believed if it resolves to a real place. Someone who
   * ignores the question and asks for something else must not have "find me
   * pizza" recorded as where they live — a wrong fact here quietly spoils every
   * later task, and unlike a wrong action nobody sees it happen.
   */
  const parked = await withWorkspace(options.pool, scope, (client) => peek(client, scope));
  if (parked) {
    const place = await resolvePlace(objective);
    if (place) {
      await withWorkspace(options.pool, scope, (client) =>
        remember(client, scope, {
          key: LOCATION_KEY,
          value: place,
          category: "travel",
          provenance: "user",
        })
      );
      await reply(`${place} — noted. Carrying on.`);
      return resumeParked(options, message, scope, resolved.provider);
    }
  }

  /**
   * "Every morning at 6, scan the AI news" is a standing instruction, not a task
   * to do once — and doing it once and forgetting is the failure the user
   * actually reported, twice.
   *
   * Ordered before the task write on purpose: a schedule is not a task, and
   * recording it as one would leave a permanently "running" row for work that
   * has not started and a "done" row for work that never ends.
   */
  const requested = await parseScheduleRequest(objective, {
    provider: resolved.provider,
    model: options.modelId,
  });

  if (requested) {
    await withWorkspace(options.pool, scope, (client) =>
      createSchedule(client, scope, {
        label: requested.label,
        prompt: requested.task,
        everyMinutes: requested.everyMinutes,
        firstRunAt: requested.firstRunAt,
        threadRef: message.envelope.threadRef,
      })
    );
    await reply(describeSchedule(requested));
    return undefined;
  }

  /**
   * "Near me" needs somewhere to be near.
   *
   * Asked rather than guessed, and asked *before* the browser opens: watched
   * live, the agent searched the literal phrase "near me", because a datacentre
   * browser has no useful idea where its user is. Instinct does not solve this
   * with geolocation either — it asked once at onboarding and never forgot.
   */
  if (needsLocation(objective)) {
    const known = await withWorkspace(options.pool, scope, (client) => locationOf(client, scope));
    if (!known) {
      await withWorkspace(options.pool, scope, (client) =>
        park(client, scope, {
          id: taskId,
          objective,
          threadRef: message.envelope.threadRef,
        })
      );
      await reply("Where are you? A city is enough — or send your location and I'll remember it.");
      return undefined;
    }
  }

  return executeTask(options, {
    scope,
    taskId,
    objective,
    threadRef: message.envelope.threadRef,
    model: resolved.provider,
  });
}

interface TaskRun {
  readonly scope: AccessScope;
  readonly taskId: string;
  readonly objective: string;
  readonly threadRef: string;
  readonly model: ModelProvider;
}

/**
 * Run one objective and report it.
 *
 * Separated from message handling because a task can start two ways — someone
 * asks for it, or someone answers the question that was blocking it — and both
 * must behave identically from here on. A resumed task that skipped the "On it"
 * or wrote a different row would be a second, subtly different code path for
 * the thing that matters most.
 */
async function executeTask(options: NellOptions, run: TaskRun): Promise<LoopOutcome> {
  const log = options.log ?? (() => undefined);
  const reply = (text: string) =>
    sendMessage({ token: options.telegramToken, chatId: run.threadRef, text });

  await withWorkspace(options.pool, run.scope, async (client) => {
    await client.query(
      `INSERT INTO tasks (id, workspace_id, label, status, channel_thread_ref, updated_at)
       VALUES ($1, $2, $3, 'running', $4, now())
       ON CONFLICT (id) DO UPDATE SET status = 'running', updated_at = now()`,
      [run.taskId, run.scope.workspaceId, run.objective.slice(0, 120), run.threadRef]
    );
  });

  await reply("On it.");

  /**
   * What Nell knows about this person, sent with every plan.
   *
   * The reason the profile exists: "near me" is unanswerable without it, and so
   * is any preference the user stated once and reasonably expects to hold.
   */
  const profile = await withWorkspace(options.pool, run.scope, (client) =>
    readProfile(client, run.scope)
  );

  let outcome: LoopOutcome;

  try {
    const session = await options.sessions.acquire(run.scope);

    outcome = await runLoop(
      {
        provider: options.browser,
        executor: new BrowserExecutor({ driver: options.browser }),
        model: run.model,
        modelId: options.modelId,
        ...(options.search ? { search: options.search } : {}),
      },
      {
        scope: run.scope,
        sessionId: session.id,
        objective: run.objective,
        profile: profileForPrompt(profile, run.scope),
        // Sent as they happen, so a slow task is visibly working rather than
        // silently hung. Silence is what makes people ask again.
        onStep: (note) => {
          log(`  ${note}`);
          void reply(note);
        },
        // Vendor text, for the log only. Nothing here is ever sent.
        onDiagnostic: (note) => {
          log(`  ! ${note}`);
        },
      }
    );
  } catch (error) {
    // `error.message`, verbatim, whatever it happened to be. Someone who asked
    // for cinema times should not receive a stack frame.
    const failure = humanise(error);
    log(`  ! task failed: ${failure.detail}`);
    outcome = { ok: false, steps: 0, reason: failure.message, detail: failure.detail };
  }
  // No `finally` closing the browser: the session outlives the task on purpose,
  // because the logins and cookies in it are what make the next task cheaper.
  // It is closed on shutdown, or when the user asks for it to be destroyed —
  // which is a deletion with a receipt, not cleanup.

  await withWorkspace(options.pool, run.scope, async (client) => {
    await client.query(`UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1`, [
      run.taskId,
      outcome.ok ? "done" : "failed",
    ]);
  });

  // The answer if there is one, and what was done if the task had no answer to
  // give. Never both: prefixing the result with "Done — I searched three sites"
  // buries it, and the result is the only part anyone asked for.
  const said = outcome.ok ? outcome.answer || `Done — ${outcome.summary}` : outcome.reason;

  /**
   * The reply is logged, not only the steps leading to it.
   *
   * Without this the record of a task stopped at its progress notes, so when the
   * user reported a bad message there was no way to see what had been sent — the
   * outcome had to be inferred from the steps before it.
   */
  if (!outcome.ok) log(`  → ${said.slice(0, 200)}`);

  await reply(said);
  return outcome;
}

/**
 * Pick up whatever was waiting on the answer that just arrived.
 *
 * Returns undefined when nothing was parked, which is the ordinary case for a
 * user volunteering their location before being asked.
 */
async function resumeParked(
  options: NellOptions,
  message: InboundMessage,
  scope: AccessScope,
  model: ModelProvider
): Promise<LoopOutcome | undefined> {
  const parked = await withWorkspace(options.pool, scope, (client) => peek(client, scope));
  if (!parked) return undefined;

  await withWorkspace(options.pool, scope, (client) => unpark(client, scope, parked.id));

  return executeTask(options, {
    scope,
    taskId: parked.id,
    objective: parked.objective,
    threadRef: parked.threadRef ?? message.envelope.threadRef,
    model,
  });
}

async function ensureWorkspace(options: NellOptions, scope: AccessScope): Promise<void> {
  await withWorkspace(options.pool, scope, async (client) => {
    await client.query(`INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      scope.workspaceId,
    ]);
  }).catch(() => undefined);
}

/**
 * Poll Telegram until stopped.
 *
 * The offset is advanced only after a batch is handled, so a crash mid-task
 * redelivers rather than loses. For a channel where a lost message is a task
 * that never happened, redelivering twice is the better failure — and the task
 * id is the message id, so the second delivery updates the same row rather than
 * starting a second task.
 */
export async function run(options: NellOptions, signal?: AbortSignal): Promise<void> {
  const log = options.log ?? (() => undefined);
  let offset = 0;

  log("listening on Telegram");

  while (!signal?.aborted) {
    let batch;
    try {
      batch = await pollOnce(
        { token: options.telegramToken, knownSenders: options.knownSenders },
        offset
      );
    } catch {
      // A network blip should not end the process. Wait and try again.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    for (const message of batch.messages) {
      if (signal?.aborted) break;
      log(`> ${message.envelope.text.slice(0, 80)}`);
      await handleMessage(options, message).catch((error: unknown) => {
        log(`  failed: ${error instanceof Error ? error.message : "unknown"}`);
        return undefined;
      });
    }

    offset = batch.nextOffset;
  }
}
