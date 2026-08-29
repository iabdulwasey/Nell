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
import {
  capabilityReport,
  describeCapabilities,
  explainUnsupported,
  isBareReply,
  REFERENCE_CATALOG,
  planWork,
  providerFor,
  unsupported,
  type Capability,
  type ClientTool,
  type ModelCapability,
  type ModelProvider,
  type ProviderKeys,
} from "@nell/agent";
import type { BrowserProvider } from "@nell/browser";
import type { SearchProvider } from "@nell/integrations";
import { greeting } from "@nell/memory";
import { accessScopeForUser, type AccessScope } from "@nell/shared";
import type { Pool } from "pg";
import { runLoop, type LoopOutcome } from "./agent-loop.js";
import { withWorkspace } from "./db.js";
import { answerAboutFiles, fetchAttachment, readableKind, type StoredFile } from "./documents.js";
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
import { runPipeline } from "./pipeline.js";
import type { CredentialOffer } from "./vault-secrets.js";
import type { VaultItemSummary } from "./vault-store.js";
import {
  pollOnce,
  replyToStranger,
  sendDocument,
  sendMessage,
  type InboundMessage,
} from "./telegram-poll.js";
import type { WorkspaceSessions } from "./workspace-session.js";

export interface NellOptions {
  readonly pool: Pool;
  readonly browser: BrowserProvider;
  /** The workspace's long-lived browser. Outlives any one task, by design. */
  readonly sessions: WorkspaceSessions;
  /**
   * The policy chokepoint, held for the life of the process rather than built
   * per task.
   *
   * Not tidiness. The executor holds the taint state — which fields on this
   * session have had a credential typed into them — and the session outlives
   * the task. A fresh executor each task forgot that a password had been filled
   * a minute earlier, on a page still open in the same browser, which quietly
   * unblocked the reads the taint machine exists to block.
   *
   * It also holds spend approvals, so the "yes" that answers a payment question
   * has to reach the same instance that refused the click.
   */
  readonly executor: BrowserExecutor;
  /**
   * Optional. Without it the agent must reach every page by navigating, and
   * search engines serve automated browsers a captcha — so research tasks fail
   * on the way to the results rather than on the results.
   */
  readonly search?: SearchProvider;
  /** Where files the user sends are kept. One directory per workspace. */
  readonly fileRoot: string;
  /**
   * What this deployment can actually do.
   *
   * `assist` needs a vendor with server-side tools; `image` needs one that makes
   * pictures. A plan that reaches for something absent should say so rather than
   * fail obscurely partway through.
   */
  readonly capabilities: ReadonlySet<Capability>;
  /** Key and model for the assist step, when this install has one. */
  readonly assistKey?: string;
  readonly assistModel?: string;
  /** Specialists the model may call — a vendor that draws, for instance. */
  readonly tools?: readonly ClientTool[];
  /**
   * Per-capability model overrides, so an install can be complete when no single
   * vendor is — one model to reason, another to draw.
   */
  readonly assignment?: Readonly<Partial<Record<ModelCapability, string>>>;
  /** Vendors this install has a key for, so settings can suggest the missing one. */
  readonly vendorKeys: ReadonlySet<string>;
  /**
   * The vault, when this install has a key for it.
   *
   * Absent means every stored-credential path is simply unavailable — no
   * listing, no link, and nothing offered to the planner. That is a legitimate
   * way to run Nell and it behaves exactly as it did before the vault existed:
   * it reaches a sign-in and says so.
   */
  readonly vault?: {
    /** Items held for this workspace. Never values. */
    readonly list: (scope: AccessScope) => Promise<readonly VaultItemSummary[]>;
    readonly forget: (scope: AccessScope, itemId: string) => Promise<boolean>;
    /** A one-time loopback link for adding one. */
    readonly link: (scope: AccessScope, origin?: string) => string;
    /** Items usable on the page the browser has actually reached. */
    readonly offers: (scope: AccessScope, origin: string) => Promise<readonly CredentialOffer[]>;
  };
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
/**
 * The last few files each workspace sent.
 *
 * In memory on purpose, and the limitation is real: a restart forgets them.
 * A schema for something whose useful life is the next few messages would be
 * the wrong trade, and this is small enough to replace when it stops being.
 */
const recent = new Map<string, StoredFile[]>();

export interface Live {
  /** Drains what the user has said since the task started. */
  readonly steering?: () => readonly string[];
  /** Aborts the task between steps. */
  readonly signal?: AbortSignal;
  /**
   * Called when a task stops at a payment, with the exact button it stopped at.
   * The caller keeps it so a later "yes" can be bound to that button and nothing
   * else.
   */
  readonly onApprovalNeeded?: (label: string, sessionId: string) => void;
}

export async function handleMessage(
  options: NellOptions,
  message: InboundMessage,
  live: Live = {}
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
    } else if (command === "/models" || command === "/capabilities") {
      /**
       * What this install can do, and what would fix the gaps.
       *
       * Worth a command rather than a config file, because the limitation is
       * otherwise invisible until a task fails: someone on Claude discovers it
       * cannot draw by asking for a picture and being told no. Told up front, it
       * is a decision about which key to add.
       */
      await reply(
        describeCapabilities(
          capabilityReport(
            {
              defaultModel: options.modelId,
              ...(options.assignment ? { overrides: options.assignment } : {}),
            },
            (id: string) => {
              const entry = REFERENCE_CATALOG.find((model) => model.id === id);
              return entry
                ? { provider: entry.provider, supportsVision: entry.supportsVision }
                : undefined;
            },
            options.vendorKeys
          )
        )
      );
    } else if (command === "/vault") {
      await ensureWorkspace(options, scope);
      await reply(await vaultCommand(options, scope, objective));
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
    /**
     * Unless something is waiting on exactly this word.
     *
     * "Yes" is small talk when nothing was asked and consent when something was
     * — and a payment question is the case where getting that backwards is
     * worst: the task sits parked forever while the user is told "Anything you
     * need?" in reply to the approval they just gave.
     */
    await ensureWorkspace(options, scope);
    const pending = await withWorkspace(options.pool, scope, (client) => peek(client, scope));
    if (!pending) {
      await reply("Anything you need?");
      return undefined;
    }
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
  /**
   * A file, and then a question about it.
   *
   * Kept in memory rather than a table, and that is a real limitation: a
   * restart forgets the resume. It is the right trade for now — the alternative
   * is a schema for something whose useful life is the next few messages — and
   * it is stated here rather than discovered later.
   */
  if (message.attachment) {
    const stored = await fetchAttachment(scope, message.attachment, {
      token: options.telegramToken,
      root: options.fileRoot,
    });

    if (!stored) {
      await reply("I couldn't download that file. Try sending it again?");
      return undefined;
    }

    recent.set(scope.workspaceId, [...(recent.get(scope.workspaceId) ?? []).slice(-3), stored]);

    const kind = readableKind(stored.mimeType, stored.name);
    if (!kind) {
      // Told, not silently accepted. A confident review of a file nobody could
      // read is worse than being asked for a different format.
      await reply(
        `Got ${stored.name}, but I can't read that format — send it as a PDF, an image or plain text and I'll take a proper look.`
      );
      return undefined;
    }

    // A caption is the question. Without one, wait for it.
    const asked = objective && !objective.startsWith("Sent ") ? objective : "";
    if (!asked) {
      await reply(`Got ${stored.name}. What would you like me to do with it?`);
      return undefined;
    }
  }

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
    return resumeParked(options, message, scope, resolved.provider, live);
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
    /**
     * A yes to a payment resumes the task rather than starting a new one.
     *
     * The approval itself was granted before this ran — it has to be in place
     * before the click is retried, or the very turn it was approved for would
     * be refused again.
     */
    if (affirmative(objective)) {
      return resumeParked(options, message, scope, resolved.provider, live);
    }

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
      return resumeParked(options, message, scope, resolved.provider, live);
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
    live,
  });
}

interface TaskRun {
  readonly scope: AccessScope;
  readonly taskId: string;
  readonly objective: string;
  readonly threadRef: string;
  readonly model: ModelProvider;
  readonly live?: Live;
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

  let sessionId: string | undefined;
  let outcome: LoopOutcome;
  const produced: { readonly path: string; readonly name: string }[] = [];

  try {
    const files = recent.get(run.scope.workspaceId) ?? [];

    /**
     * Decide what this needs before doing any of it.
     *
     * The layer that was missing. Every request used to become a browser task,
     * because the browser worker was the only worker — so "read my resume and
     * roast it" opened a page, and "what is the news" drove a search engine that
     * captcha'd it. Both are model jobs; neither needs a browser.
     */
    const plan = await planWork({
      provider: run.model,
      model: options.modelId,
      message: run.objective,
      files: files.map((file) => file.name),
    });

    const missing = unsupported(plan.steps, options.capabilities);
    if (missing.length > 0) {
      await reply(explainUnsupported(missing));
      return { ok: false, steps: 0, reason: explainUnsupported(missing) };
    }

    log(`  plan: ${plan.steps.map((step) => step.capability).join(" → ")}`);
    await reply(plan.summary || "On it.");

    const result = await runPipeline(
      {
        browser: options.browser,
        executor: options.executor,
        model: run.model,
        modelId: options.modelId,
        ...(options.search ? { search: options.search } : {}),
        ...(options.assistKey ? { assistKey: options.assistKey } : {}),
        ...(options.assistModel ? { assistModel: options.assistModel } : {}),
        ...(options.tools?.length ? { tools: options.tools } : {}),
        ...(options.vault ? { credentials: options.vault.offers } : {}),
        outputRoot: options.fileRoot,
        onStep: (note) => {
          log(`  ${note}`);
          void reply(note);
        },
        onDiagnostic: (note) => {
          log(`  ! ${note}`);
        },
      },
      {
        scope: run.scope,
        // A callback, so a plan that never browses never launches a browser —
        // and most plans do not.
        sessionId: async () => {
          const session = await options.sessions.acquire(run.scope);
          sessionId = session.id;
          return session.id;
        },
        objective: run.objective,
        files,
        profile: profileForPrompt(profile, run.scope),
        ...(run.live?.steering ? { steering: run.live.steering } : {}),
        ...(run.live?.signal ? { signal: run.live.signal } : {}),
      },
      plan.steps
    );

    produced.push(...result.files);
    outcome = result.ok
      ? { ok: true, steps: plan.steps.length, summary: plan.summary, answer: result.text }
      : { ok: false, steps: plan.steps.length, reason: result.text };
  } catch (error) {
    // `error.message`, verbatim, whatever it happened to be. Someone who asked
    // for cinema times should not receive a stack frame.
    const failure = humanise(error);
    log(`  ! task failed: ${failure.detail}`);
    outcome = { ok: false, steps: 0, reason: failure.message, detail: failure.detail };
  }

  // Files first: a document is the answer, and a paragraph about it read before
  // it arrives is a paragraph about nothing.
  for (const file of produced) {
    await sendDocument({
      token: options.telegramToken,
      chatId: run.threadRef,
      path: file.path,
      name: file.name,
    });
  }

  await withWorkspace(options.pool, run.scope, async (client) => {
    await client.query(`UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1`, [
      run.taskId,
      outcome.ok ? "done" : "failed",
    ]);
  });

  // The answer if there is one, and what was done if the task had no answer to
  // give. Never both: prefixing the result with "Done — I searched three sites"
  // buries it, and the result is the only part anyone asked for.
  /**
   * Stopping at a payment is not a failure, and must not be reported as one.
   *
   * The task is parked rather than closed, so a "yes" resumes it from where it
   * stopped instead of starting the whole booking again — which would be both
   * slow and a second chance to get a different price.
   */
  if (!outcome.ok && outcome.needsApproval) {
    await withWorkspace(options.pool, run.scope, (client) =>
      park(client, run.scope, {
        id: run.taskId,
        objective: run.objective,
        threadRef: run.threadRef,
      })
    );
    run.live?.onApprovalNeeded?.(labelIn(outcome.reason), sessionId ?? "");
    log(`  → ${outcome.reason.slice(0, 160)}`);
    await reply(outcome.reason);
    return outcome;
  }

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
  model: ModelProvider,
  live?: Live
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
    ...(live ? { live } : {}),
  });
}

/**
 * Is this a yes?
 *
 * Deliberately narrow. A payment is the one place where reading "sure, but
 * check the date first" as consent would be unrecoverable, so anything that is
 * not plainly an affirmative is treated as not one — and the cost of being
 * wrong in that direction is one more question.
 */
function affirmative(text: string): boolean {
  return /^(yes|yep|yeah|yup|ok|okay|sure|go ahead|do it|confirm(ed)?|approved?|book it|buy it)\b[\s.!]*$/iu.test(
    text.trim()
  );
}

/**
 * The button out of an approval question.
 *
 * `askBeforeSpending` builds the sentence, so this reads it back rather than
 * threading the label through every layer between the gate and the channel. It
 * is the same module's format on both sides, which is why matching on it is
 * reasonable here and would not be if a model had written the string.
 */
function labelIn(question: string): string {
  return /"([^"]+)"/u.exec(question)?.[1] ?? "";
}

async function ensureWorkspace(options: NellOptions, scope: AccessScope): Promise<void> {
  await withWorkspace(options.pool, scope, async (client) => {
    await client.query(`INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      scope.workspaceId,
    ]);
  }).catch(() => undefined);
}

/**
 * `/vault`, `/vault add [site]`, `/vault forget <n>`.
 *
 * Listing and forgetting happen here, in the chat, because neither involves a
 * secret — a label and a site name are not worth a round trip to a browser.
 * *Adding* is the one that leaves: it returns a link rather than asking the
 * question, because the answer to that question would be a password, and a
 * password typed into a chat has been sent to a company before anyone can delete
 * it. The link goes to a page this process serves on loopback.
 *
 * The numbers are positions in the list just shown, not ids. An id is a UUID and
 * asking someone to retype one from a phone is asking them to make a mistake in
 * the one place where the consequence is deleting the wrong credential.
 */
async function vaultCommand(
  options: NellOptions,
  scope: AccessScope,
  objective: string
): Promise<string> {
  const vault = options.vault;
  if (!vault) {
    return [
      "The vault is switched off — this install has no encryption key, so there is",
      "nowhere safe to keep a password and I will not keep one anywhere else.",
      "",
      "To turn it on, set SECRET_ENCRYPTION_KEY and restart me:",
      "openssl rand -base64 32",
    ].join("\n");
  }

  const [, verb = "", ...rest] = objective.split(/\s+/u);
  const items = await vault.list(scope);

  if (verb.toLowerCase() === "add") {
    /**
     * Minted only when asked for, and it expires.
     *
     * A standing URL that adds credentials to your vault is a standing URL that
     * adds credentials to your vault, and it would sit in a chat history forever.
     */
    const url = vault.link(scope, rest[0]);
    return [
      `Open this on the computer I'm running on: ${url}`,
      "",
      "It works once and expires in ten minutes. Typing the password there instead of",
      "here means it goes straight into the vault without passing through Telegram.",
    ].join("\n");
  }

  if (verb.toLowerCase() === "forget") {
    const index = Number(rest[0]);
    const target = Number.isInteger(index) ? items[index - 1] : undefined;
    if (!target) return "Send /vault to see the list, then /vault forget with a number from it.";
    const gone = await vault.forget(scope, target.id);
    return gone ? `Forgotten: ${target.label}.` : "That one was already gone.";
  }

  if (items.length === 0) {
    return [
      "Nothing saved yet. Send /vault add to store a login — I'll give you a link to",
      "type it into, so it never goes through this chat.",
      "",
      "Once one is saved I can sign in to that site myself. I only ever see a label;",
      "the password is typed into the page without passing through me.",
    ].join("\n");
  }

  return [
    "Saved logins:",
    ...items.map(
      (item, index) =>
        `${String(index + 1)}. ${item.label}${item.accountHint ? ` — ${item.accountHint}` : ""} (${item.origins
          .map((origin) => origin.replace(/^https?:\/\//u, ""))
          .join(", ")})`
    ),
    "",
    "/vault add to store another · /vault forget <number> to remove one.",
  ].join("\n");
}

/**
 * A task that is currently running, and the way to talk to it.
 *
 * Held so an inbound message can reach work already in progress rather than
 * queueing behind it — which is the difference between an assistant and a form
 * submission.
 */
interface Running {
  readonly workspaceId: string;
  /** Drained by the loop at the start of each turn. */
  readonly steering: string[];
  readonly abort: AbortController;
}

/**
 * A payment the agent stopped at, waiting for a person.
 *
 * Held in memory on purpose: an approval that survived a restart would be a
 * "yes" outliving the page it was given about, and the page is where the price
 * is. Losing it costs one repeated question.
 */
interface AwaitingApproval {
  readonly workspaceId: string;
  /** The exact button, so consent cannot be transferred to a different one. */
  readonly label: string;
  readonly sessionId: string;
}

/**
 * Read and work at the same time.
 *
 * The poll and the worker are separate loops on purpose. Awaiting a task before
 * polling again — which is what this used to do — means Nell does not even
 * *fetch* a message while it is busy, and a task now runs for minutes. Watching
 * it head somewhere wrong with no way to say "not there" was the most obvious
 * thing missing, and the cause was one `await` in the wrong place.
 *
 * The offset still advances only after a batch has been taken in, so a crash
 * redelivers rather than loses. A redelivered message updates the same task row,
 * because the task id is the message id.
 */
export async function run(options: NellOptions, signal?: AbortSignal): Promise<void> {
  const log = options.log ?? (() => undefined);
  const inbox: InboundMessage[] = [];
  let running: Running | undefined;
  let waiting: AwaitingApproval | undefined;

  log("listening on Telegram");

  const polling = (async () => {
    let offset = 0;

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
        const text = message.envelope.text.trim();
        log(`> ${text.slice(0, 80)}`);

        const mine =
          running !== undefined &&
          message.userId !== undefined &&
          accessScopeForUser(message.userId).workspaceId === running.workspaceId;

        if (mine && running) {
          /**
           * "Stop" is unambiguous and immediate.
           *
           * Every other message is handed to the task as a correction, but this
           * one cannot wait for the next turn to be considered — the whole point
           * of saying it is that something is going wrong now.
           */
          if (/^(stop|cancel|abort|never ?mind)\b/iu.test(text)) {
            running.abort.abort();
            log("  ! stopped by user");
            await sendMessage({
              token: options.telegramToken,
              chatId: message.envelope.threadRef,
              text: "Stopping.",
            });
            continue;
          }

          running.steering.push(text);
          log("  ! steering the running task");
          continue;
        }

        inbox.push(message);
      }

      offset = batch.nextOffset;
    }
  })();

  /**
   * One task at a time, deliberately.
   *
   * A workspace has one browser, so two tasks would be two agents fighting over
   * one page. Queueing is the honest shape; the fix for a slow queue is the
   * coordinator, not concurrency bolted on here.
   */
  while (!signal?.aborted) {
    const message = inbox.shift();
    if (!message) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    const abort = new AbortController();
    const steering: string[] = [];
    const workspaceId = message.userId ? accessScopeForUser(message.userId).workspaceId : undefined;
    running = workspaceId ? { workspaceId, steering, abort } : undefined;

    /**
     * A "yes" that arrived before this task started.
     *
     * The message that resumes a parked payment is handled here rather than in
     * the poll loop, because the executor's approval must be in place *before*
     * the task runs — granting it afterwards would let the click be refused a
     * second time on the very turn it was approved for.
     */
    if (waiting && workspaceId === waiting.workspaceId && affirmative(message.envelope.text)) {
      options.executor.approveSpend(waiting.sessionId, waiting.label);
      log(`  ! approved: ${waiting.label}`);
      waiting = undefined;
    } else if (waiting && workspaceId === waiting.workspaceId) {
      // Anything that is not a yes withdraws it. Silence is not consent, and
      // neither is a change of subject.
      options.executor.revokeSpend(waiting.sessionId);
      waiting = undefined;
    }

    await handleMessage(options, message, {
      steering: () => steering.splice(0, steering.length),
      signal: abort.signal,
      onApprovalNeeded: (label, sessionId) => {
        if (workspaceId) waiting = { workspaceId, label, sessionId };
      },
    }).catch((error: unknown) => {
      log(`  failed: ${error instanceof Error ? error.message : "unknown"}`);
      return undefined;
    });

    running = undefined;
  }

  await polling;
}
