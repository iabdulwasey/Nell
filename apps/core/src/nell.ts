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
import { isBareReply, providerFor, type ProviderKeys } from "@nell/agent";
import type { BrowserProvider } from "@nell/browser";
import type { SearchProvider } from "@nell/integrations";
import { greeting } from "@nell/memory";
import { accessScopeForUser } from "@nell/shared";
import type { Pool } from "pg";
import { runLoop, type LoopOutcome } from "./agent-loop.js";
import { withWorkspace } from "./db.js";
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

  await withWorkspace(options.pool, scope, async (client) => {
    await client.query(`INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      scope.workspaceId,
    ]);
  }).catch(() => undefined);

  await withWorkspace(options.pool, scope, async (client) => {
    await client.query(
      `INSERT INTO tasks (id, workspace_id, label, status, channel_thread_ref, updated_at)
       VALUES ($1, $2, $3, 'running', $4, now())
       ON CONFLICT (id) DO UPDATE SET status = 'running', updated_at = now()`,
      [taskId, scope.workspaceId, objective.slice(0, 120), message.envelope.threadRef]
    );
  });

  await reply("On it.");

  let outcome: LoopOutcome;

  try {
    const session = await options.sessions.acquire(scope);

    outcome = await runLoop(
      {
        provider: options.browser,
        executor: new BrowserExecutor({ driver: options.browser }),
        model: resolved.provider,
        modelId: options.modelId,
        ...(options.search ? { search: options.search } : {}),
      },
      {
        scope,
        sessionId: session.id,
        objective,
        // Sent as they happen, so a slow task is visibly working rather than
        // silently hung. Silence is what makes people ask again.
        onStep: (note) => {
          log(`  ${note}`);
          void reply(note);
        },
      }
    );
  } catch (error) {
    outcome = {
      ok: false,
      steps: 0,
      reason: error instanceof Error ? error.message : "Something went wrong.",
    };
  }
  // No `finally` closing the browser: the session outlives the task on purpose,
  // because the logins and cookies in it are what make the next task cheaper.
  // It is closed on shutdown, or when the user asks for it to be destroyed —
  // which is a deletion with a receipt, not cleanup.

  await withWorkspace(options.pool, scope, async (client) => {
    await client.query(`UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1`, [
      taskId,
      outcome.ok ? "done" : "failed",
    ]);
  });

  // The answer if there is one, and what was done if the task had no answer to
  // give. Never both: prefixing the result with "Done — I searched three sites"
  // buries it, and the result is the only part anyone asked for.
  await reply(outcome.ok ? outcome.answer || `Done — ${outcome.summary}` : outcome.reason);
  return outcome;
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
