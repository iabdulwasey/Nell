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
  routeMessage,
  planWork,
  providerFor,
  unsupported,
  type Capability,
  type ClientTool,
  type ModelCapability,
  type ModelProvider,
  type ProviderKeys,
  type Task,
} from "@nell/agent";
import type { BrowserProvider } from "@nell/browser";
import type { SearchProvider } from "@nell/integrations";
import {
  buildIndex,
  deletionScopeSchema,
  exportMemory,
  greeting,
  plan,
  renderBrain,
  renderRecalled,
  searchMemory,
  type DeletionReceipt,
} from "@nell/memory";
import type { VaultItemKind } from "@nell/vault";
import { accessScopeForUser, type AccessScope } from "@nell/shared";
import type { Pool } from "pg";
import { runLoop, type LoopOutcome, type Steer } from "./agent-loop.js";
import { catalogLookup } from "./assignment.js";
import { withWorkspace } from "./db.js";
import { answerAboutFiles, fetchAttachment, readableKind, type StoredFile } from "./documents.js";
import { humanise } from "./failure.js";
import { resolvePlace, reverseGeocode } from "./geocode.js";
import { abandon, park, peek, unpark } from "./pending-task.js";
import {
  LOCATION_KEY,
  locationOf,
  needsLocation,
  profileForPrompt,
  readProfile,
  remember,
} from "./profile.js";
import { decideFollowUp } from "./follow-up.js";
import { describeLearned, learnFrom } from "./learn.js";
import { classifyMidTask, type MidTaskIntent } from "./mid-task.js";
import { assignmentFor, listKeys } from "./workspace-models.js";
import { deleteScope, renderReceipt } from "./deletion-store.js";
import { memorySources } from "./memory-store.js";
import { describeSchedule, parseScheduleRequest } from "./schedule-request.js";
import { cancelAll, createFollowUp, createSchedule, listSchedules } from "./schedules.js";
import { runPipeline } from "./pipeline.js";
import {
  addRule,
  extendOutcome,
  readDirectives,
  readLedger,
  recordOutcome,
} from "./memory-store.js";
import {
  MIN_RECALL_TOKENS,
  PROMPT_RESERVE_TOKENS,
  recallBudgetFor,
  recentTurns,
  rememberTurn,
  renderConversation,
} from "./conversation.js";
import { compact, forgetNote, readNotes, renderNotes, writeNote } from "./notes.js";
import { withMachine } from "./machine-lock.js";
import type { AuditView } from "./audit-store.js";
import { FORMS } from "./vault-kinds.js";
import type { CredentialOffer } from "./vault-secrets.js";
import type { VaultItemSummary } from "./vault-store.js";
import {
  closeForumTopic,
  openForumTopic,
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
  /** For an OpenAI-compatible endpoint on the operator's own hardware. */
  readonly assistBaseUrl?: string;
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
   * Whether a workspace may choose its own models and bring its own keys.
   *
   * An operator selling a service has a real reason to say no — their margin
   * depends on which models run. Defaults to yes, because the common deployment
   * is one person running it for themselves.
   */
  readonly allowUserModels?: boolean;
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
    /** A one-time loopback link for adding one, prefilled with what is known. */
    readonly link: (
      scope: AccessScope,
      origin?: string,
      username?: string,
      kind?: VaultItemKind
    ) => string;
    /** The account this person signs in with, from what they have saved before. */
    readonly knownAccount: (scope: AccessScope) => Promise<string | undefined>;
    /** Items usable on the page the browser has actually reached. */
    readonly offers: (scope: AccessScope, origin: string) => Promise<readonly CredentialOffer[]>;
  };
  /** What was done, and whether the record of it still verifies. */
  readonly audit?: (scope: AccessScope) => Promise<AuditView>;
  /**
   * Write a deletion into the audit chain.
   *
   * The one record that must outlive the data it describes. Optional because an
   * install with no audit sink still deletes correctly — it simply cannot prove
   * afterwards that it did, which is a smaller loss than refusing to delete.
   */
  readonly recordDeletion?: (scope: AccessScope, receipt: DeletionReceipt) => Promise<void>;
  /**
   * A one-time link to read and edit `MEMORY.md`.
   *
   * Not under `vault`, because it needs no encryption key — an install with no
   * vault can still let someone correct what Nell believes about them.
   */
  readonly memoryLink?: (scope: AccessScope) => string;
  /**
   * Runs one pipeline step durably, when an engine is configured.
   *
   * Threaded from `main` rather than resolved here, so nothing in this file
   * knows which engine — or that there is one. Absent means steps simply run
   * and a crash loses the task, which is a legitimate way to deploy.
   */
  readonly durably?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
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
  readonly steering?: () => readonly Steer[];
  /**
   * Each progress note, so the caller can keep the last few.
   *
   * A mid-task correction is unjudgeable without them: *"not that theatre"*
   * names something that exists only in the last handful of steps.
   */
  readonly onNote?: (note: string) => void;
  /**
   * This task's own Telegram thread, once one has been opened.
   *
   * A function rather than a value because the topic is created *after* the
   * handler starts — the title is the request, and the request is what starts it.
   */
  readonly topicId?: () => number | undefined;
  /** Aborts the task between steps. */
  readonly signal?: AbortSignal;
  /**
   * Called when a task stops at a payment, with the exact button it stopped at.
   * The caller keeps it so a later "yes" can be bound to that button and nothing
   * else.
   */
  readonly onApprovalNeeded?: (label: string, sessionId: string) => void;
  /**
   * What to call this task in a reply, when several are in flight.
   *
   * Returns undefined when it is the only one, because a prefix on a single
   * conversation is noise. A function rather than a value: whether it is needed
   * depends on what else is running *when the reply is sent*, not on what was
   * running when the task started.
   */
  readonly label?: () => string | undefined;
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
      await ensureWorkspace(options, scope);

      /**
       * This workspace's answer, not the process's.
       *
       * `/models` described the operator's configuration to everybody, which was
       * right while one process served one person and wrong the moment it serves
       * two. The merge lives in `assignmentFor`, so what this prints and what
       * actually runs are one computation.
       */
      const mine = await withWorkspace(options.pool, scope, (client) =>
        assignmentFor(
          client,
          scope,
          {
            defaultModel: options.modelId,
            ...(options.assignment ? { overrides: options.assignment } : {}),
          },
          options.allowUserModels ?? true
        )
      );

      const ownKeys = await withWorkspace(options.pool, scope, (client) => listKeys(client, scope));

      await reply(
        describeCapabilities(
          capabilityReport(
            mine,
            /**
             * The same lookup the picture tool is built from.
             *
             * Inlined here once, and it drifted immediately: this one refused a
             * bare vendor name, so an install that was drawing perfectly well
             * was told it could not draw.
             */
            catalogLookup,
            // The operator's keys plus this workspace's own, because a
            // capability needs a model and a key and either layer can supply it.
            new Set([...options.vendorKeys, ...ownKeys.map((entry) => entry.vendor)])
          )
        ) +
          (ownKeys.length > 0
            ? `\n\nYour own keys: ${ownKeys.map((entry) => `${entry.vendor} …${entry.hint}`).join(", ")}`
            : "")
      );
    } else if (command === "/remember") {
      await ensureWorkspace(options, scope);
      await reply(await rememberCommand(options, scope, objective));
    } else if (command === "/forget") {
      await ensureWorkspace(options, scope);
      await reply(await forgetCommand(options, scope, objective));
    } else if (command === "/memory") {
      await ensureWorkspace(options, scope);
      await reply(await memoryCommand(options, scope, objective));
    } else if (command === "/delete") {
      await ensureWorkspace(options, scope);
      await reply(await deleteCommand(options, scope, objective));
    } else if (command === "/recall") {
      await ensureWorkspace(options, scope);
      await reply(await recallCommand(options, scope, objective));
    } else if (command === "/audit") {
      await ensureWorkspace(options, scope);
      await reply(await auditCommand(options, scope));
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
     * Kept ahead of the general path and deliberately narrow: an approval is
     * the one place where reading "sure, but check the date first" as consent
     * would be unrecoverable, so it is decided by a regexp rather than by a
     * model. The approval itself was granted before this ran — it has to be in
     * place before the click is retried, or the very turn it was approved for
     * would be refused again.
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
          // Recorded verbatim, so the next message is judged against what was
          // actually asked rather than against a guess at what it might be.
          question: "Where are you? A city is enough — or send your location.",
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
    ...(parked
      ? {
          pending: {
            id: parked.id,
            objective: parked.objective,
            ...(parked.question ? { question: parked.question } : {}),
          },
        }
      : {}),
  });
}

interface TaskRun {
  readonly scope: AccessScope;
  readonly taskId: string;
  readonly objective: string;
  readonly threadRef: string;
  readonly model: ModelProvider;
  readonly live?: Live;
  /**
   * A task waiting on an answer, which this message may or may not be.
   *
   * Handed in rather than looked up here so the decision — resume it, or
   * abandon it and start something new — is made in one place, by the
   * dispatcher, which is the only thing that has read both the question and the
   * message.
   */
  readonly pending?: {
    readonly id: string;
    readonly objective: string;
    readonly question?: string;
  };
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
  /**
   * Prefixed with which request it answers, when more than one is running.
   *
   * Two tasks reporting into one flat thread produce two unlabelled answers,
   * and working out which is which is left to the reader — who did not ask for
   * that job. With one task in flight there is nothing to disambiguate and the
   * prefix is left off.
   */
  /**
   * A reply goes to the task's own thread when it has one.
   *
   * The `[label]` prefix was always a workaround for not having threads: with
   * three tasks running, one flat conversation interleaves three and the reader
   * sorts them out. A topic is the structural answer, and where a topic exists
   * the prefix is redundant — the thread already says which task this is.
   *
   * It degrades rather than fails. Telegram allows topics only in a
   * forum-enabled supergroup, so a private chat with the bot never gets one and
   * keeps the prefix, which is exactly the behaviour it had before.
   */
  const reply = (text: string) => {
    const topicId = run.live?.topicId?.();
    const name = topicId === undefined ? run.live?.label?.() : undefined;
    return sendMessage({
      token: options.telegramToken,
      chatId: run.threadRef,
      ...(topicId === undefined ? {} : { topicId }),
      text: name ? `[${name}] ${text}` : text,
    });
  };

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

  /**
   * What Nell has actually done before — the other half of the brain document.
   *
   * `task_ledger` has existed since the first migration with nothing writing to
   * it, so "Recent tasks" rendered empty and the whole document looked like a
   * thin wrapper round the preference list. It is not: precedent is what makes
   * "the same as last time" answerable.
   */
  const history = await withWorkspace(options.pool, run.scope, (client) =>
    readLedger(client, run.scope, 10)
  ).catch(() => []);

  /**
   * The document, not the row list.
   *
   * Rendered once and used for both the dispatcher and the worker, so what the
   * two see cannot drift — and it is the same markdown a person gets from
   * `/memory`, which is the property worth having: what you read is what the
   * model sees.
   */
  const written = await withWorkspace(options.pool, run.scope, (client) =>
    readNotes(client, run.scope)
  ).catch(() => []);

  /**
   * The document, not the row list.
   *
   * Rendered once and used for both the dispatcher and the worker, so what the
   * two see cannot drift — and it is the same markdown a person gets from
   * `/memory`, which is the property worth having: what you read is what the
   * model sees. Notes come after the structured facts, because the summary
   * among them is a record of a conversation rather than a fact about anybody.
   */
  const brain = [
    renderBrain({
      workspaceId: run.scope.workspaceId,
      preferences: profile,
      entries: history,
      now: Date.now(),
    }).markdown,
    renderNotes(written),
  ]
    .filter((part) => part.trim())
    .join("\n\n");

  /**
   * What was said before — read *before* the turn is written down.
   *
   * Ordering matters and is easy to get backwards: recording first would put the
   * message being handled into its own history, so the model would be shown the
   * request twice and might read the echo as a separate earlier ask.
   */
  /**
   * How much this model can hold, from the catalog.
   *
   * Falls back to the floor rather than to an optimistic guess: recalling less
   * than a model could hold makes for a poorer conversation, while recalling
   * more than it can hold makes the vendor reject the request outright, which
   * fails the task rather than degrading it.
   */
  const window =
    REFERENCE_CATALOG.find((entry) => entry.id === options.modelId)?.contextWindow ??
    MIN_RECALL_TOKENS + PROMPT_RESERVE_TOKENS;
  const budget = recallBudgetFor(window);

  const conversation = await withWorkspace(options.pool, run.scope, (client) =>
    recentTurns(client, run.scope, budget)
  );

  await withWorkspace(options.pool, run.scope, (client) =>
    rememberTurn(client, run.scope, {
      role: "user",
      body: run.objective,
      taskId: run.taskId,
      files: (recent.get(run.scope.workspaceId) ?? []).map((file) => file.name),
    })
  ).catch(() => undefined);

  let sessionId: string | undefined;
  let outcome: LoopOutcome;
  /**
   * What the task turned out to be about, once references were resolved.
   *
   * The ledger records this rather than what was typed, and the difference is
   * the difference between a useful history and a useless one: "book the second
   * one" means nothing a week later, while "book EK517, 3 September, London to
   * Delhi" is a precedent somebody can act on. Defaults to the raw message so a
   * task that dies before planning still records something true.
   */
  let resolved = run.objective;
  /**
   * Whether this message carries on the goal that just finished.
   *
   * "Find me Spider-Man showtimes" then "book two at the Sector 90 one" is one
   * job in two messages, and recording it as two leaves the history reading as
   * two separate things done — noise in the exact record meant to answer "the
   * same as last time".
   */
  let continues = false;
  /** Set when this message answered a pending question, so nothing is duplicated. */
  let resuming: string | undefined;
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
      /**
       * The dispatcher interprets as well as classifies.
       *
       * It is the one place that sees both the conversation and the request, so
       * it is where "book the second one" becomes something a worker can carry
       * out. Everything downstream takes an objective and needs no change.
       */
      ...(conversation.length > 0 ? { conversation: renderConversation(conversation) } : {}),
      ...(brain ? { profile: brain } : {}),
      /**
       * The goal that just finished, so a follow-on can be recognised as one.
       *
       * Taken from the newest ledger entry, which is where a finished goal
       * lands. Absent on a first request, and its absence is what lets the
       * answer be honest rather than guessed.
       */
      ...(history[0] ? { lastGoal: history[0].objective } : {}),
    });

    resolved = plan.objective;
    continues = plan.continuesLastGoal;

    /**
     * The message answered the question, so the task that asked it carries on.
     *
     * Two things change and both matter. The work is the *original* objective
     * enriched by the answer rather than the answer alone — "Heathrow" is not a
     * task. And no second row or ledger entry is created, so one goal that took
     * three messages reads as one thing done rather than three.
     */
    if (run.pending && plan.answersPendingQuestion) {
      resuming = run.pending.id;
      await withWorkspace(options.pool, run.scope, (client) =>
        unpark(client, run.scope, run.pending!.id)
      );
      log(`  resuming: ${run.pending.objective.slice(0, 60)}`);
    } else if (run.pending) {
      /**
       * They went somewhere else, so the old task is abandoned rather than left
       * blocked for ever. `abandoned`, not `failed`: nobody said stop and
       * nothing broke, they simply moved on — and recording a fault nobody
       * committed makes the history worse than silence.
       */
      await withWorkspace(options.pool, run.scope, (client) =>
        abandon(client, run.scope, run.pending!.id)
      ).catch(() => undefined);
    }

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
        ...(options.assistBaseUrl ? { assistBaseUrl: options.assistBaseUrl } : {}),
        ...(options.tools?.length ? { tools: options.tools } : {}),
        ...(options.vault ? { credentials: options.vault.offers } : {}),
        // Browse steps take the workspace's one browser exclusively; assist
        // steps touch no session and never wait for it.
        withMachine: (fn) => withMachine(run.scope.workspaceId, fn),
        ...(options.durably
          ? {
              /**
               * Scoped to this task, so two tasks cannot collide on a step name.
               * The engine keys checkpoints by workflow *and* step, and a shared
               * name across workflows is how one task returns another's result.
               */
              durably: <T>(name: string, fn: () => Promise<T>) =>
                options.durably!(`${run.taskId}:${name}`, fn),
            }
          : {}),
        outputRoot: options.fileRoot,
        onStep: (note) => {
          log(`  ${note}`);
          run.live?.onNote?.(note);
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
        /**
         * The resolved objective, not what was typed.
         *
         * "Book the second one" reaches here as "book Emirates EK517, 8:40pm,
         * 3 September to Delhi" — the dispatcher spelled it out from the
         * conversation, so the worker needs no history of its own.
         */
        /**
         * When resuming, the goal — not the answer to the question.
         *
         * "Heathrow" is not a task. The dispatcher has already folded the
         * answer into `objective`, so this is the original request with the
         * missing piece filled in rather than a fragment of a conversation.
         */
        objective: plan.objective,
        files,
        profile: brain,
        ...(run.live?.steering ? { steering: run.live.steering } : {}),
        ...(run.live?.signal ? { signal: run.live.signal } : {}),
      },
      plan.steps
    );

    produced.push(...result.files);

    /**
     * Stopped for want of a login — so send the way to fix it, here, now.
     *
     * This is the agent→human handoff the whole vault exists for, and the
     * moment is the point: at a sign-in wall, about a named site, while the
     * person is still thinking about the thing they asked for. Told an hour
     * later in a settings page, nobody does it.
     *
     * The site comes from the browser's live URL and the account from what the
     * user has saved before, so the link opens with everything known already in
     * it and only the password left to type. The model supplied neither.
     */
    const site = result.needsCredentialFor;
    if (!result.ok && site && options.vault) {
      const known = await options.vault.knownAccount(run.scope).catch(() => undefined);
      const link = options.vault.link(run.scope, site, known);
      outcome = {
        ok: false,
        steps: plan.steps.length,
        reason: [
          `${result.text} Add one here and I'll pick this back up: ${link}`,
          "",
          "Open it on the computer I'm running on. It works once, expires in ten",
          "minutes, and keeps the password out of this chat entirely.",
        ].join("\n"),
      };
    } else {
      outcome = result.ok
        ? { ok: true, steps: plan.steps.length, summary: plan.summary, answer: result.text }
        : { ok: false, steps: plan.steps.length, reason: result.text };
    }
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
      // Beside the work that produced it, not at the bottom of a shared thread.
      ...(run.live?.topicId?.() === undefined ? {} : { topicId: run.live.topicId() }),
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

  /**
   * And into the ledger, which is what precedent is read from later.
   *
   * Failures are recorded too. "I tried to book that and the site wanted a
   * login" is exactly the precedent that stops the same attempt being made the
   * same way next week, and a history of only successes is a history that
   * teaches nothing.
   */
  /**
   * One entry per goal, written when the goal ends — not one per message.
   *
   * A task that stops to ask something has not finished, so it gets no entry
   * yet: the `tasks` row already records that it is blocked, and writing a
   * ledger line here would mean a single booking that took three messages read
   * back as three separate things done. The entry lands when the task actually
   * concludes, carrying the objective the dispatcher resolved.
   */
  if (outcome.ok || !outcome.needsApproval) {
    await withWorkspace(options.pool, run.scope, (client) =>
      recordFor(client, run.scope, continues, {
        taskId: resuming ?? run.taskId,
        objective: resolved,
        outcome: outcome.ok ? "succeeded" : "failed",
        /**
         * What it found, so the next task does not start from nothing.
         *
         * Recorded for failures too, and that is the more useful half: *"the
         * site wanted a login"* is precisely the precedent that stops the same
         * attempt being made the same way next week, where "failed" teaches
         * nothing.
         */
        found: outcome.ok ? outcome.answer || outcome.summary : outcome.reason,
      })
    ).catch(() => undefined);
  }

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
        // The goal, not the question — this is what resumes and gets worked on.
        objective: resolved,
        threadRef: run.threadRef,
        question: outcome.reason,
      })
    );
    run.live?.onApprovalNeeded?.(labelIn(outcome.reason), sessionId ?? "");
    log(`  → ${outcome.reason.slice(0, 160)}`);
    // Recorded like any other reply: "shall I pay £42?" is the turn a later
    // "yes" refers to, and without it that "yes" means nothing.
    await withWorkspace(options.pool, run.scope, (client) =>
      rememberTurn(client, run.scope, { role: "nell", body: outcome.reason, taskId: run.taskId })
    ).catch(() => undefined);
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

  /**
   * And the reply is remembered, which is what makes the next turn work.
   *
   * Written even when the task failed: "that site needs a login" is exactly the
   * context that makes the following message ("ok add one then") intelligible,
   * and a history that records only successes reads as though the failures
   * never happened.
   */
  await withWorkspace(options.pool, run.scope, (client) =>
    rememberTurn(client, run.scope, { role: "nell", body: said, taskId: run.taskId })
  ).catch(() => undefined);

  await reply(said);

  /**
   * Decide whether to look at this again later.
   *
   * After the reply, deliberately: the answer is what they asked for, and making
   * them wait on a decision about a message they have not asked for would be the
   * wrong trade. Failures are swallowed for the same reason — a follow-up that
   * could not be arranged is a missing bonus, not a failed task.
   *
   * Only for a task that succeeded and actually said something. There is nothing
   * to go back and correct about an answer that never arrived.
   */
  /**
   * Notice what they told us about themselves, and write it down.
   *
   * `run.objective` is **their message** — not the resolved objective, not the
   * reply, not anything a page said. That choice is the security property: a
   * page cannot plant a preference and neither can Nell's own answer, which
   * quotes pages and would launder one into permanent memory where every future
   * turn reloads it.
   *
   * After the reply, deliberately. This is a bonus on top of the answer they
   * asked for, and making them wait on it would be the wrong trade — as would
   * letting a failed extraction turn a delivered answer into a failed task.
   */
  await withWorkspace(options.pool, run.scope, async (client) => {
    const learned = await learnFrom(run.objective, {
      provider: run.model,
      model: options.modelId,
      known: profile.map((preference) => preference.key),
    });
    if (!learned) return;

    for (const preference of learned.preferences) {
      await remember(client, run.scope, { ...preference, provenance: "user" });
    }
    for (const rule of learned.rules) {
      // `addRule` runs through the provenance gate, which is where an untrusted
      // source is refused. Passing "user" here is a claim that gate enforces.
      await addRule(client, run.scope, { ...rule, provenance: "user" });
    }

    const note = describeLearned(learned);
    if (note) {
      log(`  learned: ${note}`);
      /**
       * Told, briefly. A profile that changes without a word is one somebody
       * discovers by being surprised months later — which is the exact shape of
       * the competitor's own privacy scandal.
       */
      await reply(note);
    }
  }).catch(() => undefined);

  if (outcome.ok && said.trim() && run.threadRef) {
    await withWorkspace(options.pool, run.scope, async (client) => {
      const planned = await decideFollowUp(resolved, said, {
        provider: run.model,
        model: options.modelId,
      });
      if (!planned) return;

      await createFollowUp(client, run.scope, {
        label: planned.label,
        recheck: planned.recheck,
        runAt: planned.runAt,
        original: planned.original,
        threadRef: run.threadRef,
      });
      log(
        `  will check again in ${String(Math.round((planned.runAt - Date.now()) / 60_000))}m: ${planned.label}`
      );
    }).catch(() => undefined);
  }

  /**
   * Fold anything that has fallen out of the recent window, now the user is not
   * waiting.
   *
   * After the reply on purpose: compaction costs a model call, and paying for
   * one before answering would be an odd trade. Failures are swallowed because
   * a summary that could not be written is a smaller problem than a task
   * reported as failed after it succeeded — the watermark means the next task
   * picks up exactly where this one stopped.
   */
  await withWorkspace(options.pool, run.scope, (client) =>
    compact(client, run.scope, { provider: run.model, model: options.modelId }, budget)
  )
    .then((result) => {
      if (result.folded > 0) log(`  compacted ${String(result.folded)} older turns`);
    })
    .catch(() => undefined);

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
 * `/remember <anything>` — the part of memory with no column.
 *
 * A preference is a key and a value; the ledger is an objective and an amount.
 * Neither holds "planning Delhi in September, avoid early flights, passport
 * expires in November so renew first" — one thought rather than three rows.
 *
 * The lineage is `user` without needing to be checked, because a command the
 * user typed *is* the user speaking. That is the whole reason this is a command
 * rather than something the agent decides to do after reading a page.
 */
async function rememberCommand(
  options: NellOptions,
  scope: AccessScope,
  objective: string
): Promise<string> {
  const body = objective.replace(/^\/remember\s*/iu, "").trim();
  if (!body) {
    return [
      "Tell me what to remember — /remember I'm vegetarian and my partner is not.",
      "",
      "Anything at all. It goes in MEMORY.md, which you can read with /memory and I read",
      "before every task.",
    ].join("\n");
  }

  await withWorkspace(options.pool, scope, (client) =>
    writeNote(client, scope, { kind: "note", body, lineage: "user", because: "you told me" })
  );

  return `Noted: ${body}`;
}

/** `/forget <n>` — by position in the list `/memory` just showed. */
async function forgetCommand(
  options: NellOptions,
  scope: AccessScope,
  objective: string
): Promise<string> {
  const index = Number(objective.split(/\s+/u)[1]);
  const notes = (
    await withWorkspace(options.pool, scope, (client) => readNotes(client, scope))
  ).filter((note) => note.kind === "note");

  const target = Number.isInteger(index) ? notes[index - 1] : undefined;
  if (!target) return "Send /memory to see the notes, then /forget with a number from it.";

  await withWorkspace(options.pool, scope, (client) => forgetNote(client, scope, target.id));
  return `Forgotten: ${target.body}`;
}

/**
 * `/memory` — the three files, and the point of keeping memory this way.
 *
 * Memory is *stored* as rows, because that is what gives transactions, tenant
 * isolation and honest deletion. It is *shown* as `USER.md`, `MEMORY.md` and
 * `TASKS.md`, because rows are a poor thing to hand a model and a worse thing
 * to show a person — and because the file layout is one people already know.
 *
 * The property worth having is that these are not a report *about* what the
 * model sees. `MEMORY.md` is rendered from the same call that builds the
 * document going into the prompt, so what you read here is what it reads there.
 * A summary that could drift from the thing it summarises is how an agent ends
 * up confidently wrong about you with no way for you to notice.
 */
async function memoryCommand(
  options: NellOptions,
  scope: AccessScope,
  objective: string
): Promise<string> {
  const [, which = ""] = objective.split(/\s+/u);

  const { preferences, directives, entries } = await withWorkspace(
    options.pool,
    scope,
    async (client) => ({
      preferences: await readProfile(client, scope),
      directives: await readDirectives(client, scope),
      entries: await readLedger(client, scope, 50),
    })
  );

  const rendered = exportMemory({
    workspaceId: scope.workspaceId,
    preferences,
    directives,
    entries,
    now: Date.now(),
  }).files;

  /**
   * Notes are appended to `MEMORY.md` rather than given a fourth file.
   *
   * They are facts Nell recalls, which is exactly what that file is for — and a
   * `NOTES.md` would split "what it knows about you" across two places, so
   * correcting something would mean guessing which one it is in.
   */
  const written = await withWorkspace(options.pool, scope, (client) => readNotes(client, scope));
  const extra = renderNotes(written);
  const numbered = written
    .filter((note) => note.kind === "note")
    .map((note, index) => `${String(index + 1)}. ${note.body}`);

  const files: Record<string, string> = {
    ...rendered,
    "MEMORY.md": [
      rendered["MEMORY.md"]?.trimEnd() ?? "",
      extra,
      numbered.length > 0
        ? `_/forget <number> to remove one of the ${String(numbered.length)} notes._`
        : "",
    ]
      .filter((part) => part.trim())
      .join("\n\n"),
  };

  const named: Readonly<Record<string, string>> = {
    user: "USER.md",
    rules: "USER.md",
    memory: "MEMORY.md",
    facts: "MEMORY.md",
    tasks: "TASKS.md",
    history: "TASKS.md",
  };

  if (which.toLowerCase() === "edit") {
    if (!options.memoryLink) return "Editing is not available on this install.";
    return [
      `Open this on the computer I'm running on: ${options.memoryLink(scope)}`,
      "",
      "It shows exactly what I read before every task. Change a line to correct it,",
      "delete one to forget it. Works once and expires in ten minutes.",
    ].join("\n");
  }

  const wanted = named[which.toLowerCase()];
  if (wanted) return `**${wanted}**\n\n${files[wanted] ?? "_empty_"}`;

  /**
   * Everything, when nothing is named — but the whole point is being able to
   * read it, so a long history is trimmed here rather than silently cut off by
   * the channel splitting it into eight messages.
   */
  return [
    Object.entries(files)
      .map(([name, body]) => `**${name}**\n\n${body.trim()}`)
      .join("\n\n---\n\n"),
    "",
    "/memory rules · /memory facts · /memory tasks for one at a time.",
    "/remember <anything> to add a note · /forget <number> to drop one.",
    options.memoryLink
      ? `/memory edit to correct any of it: open ${options.memoryLink(scope)}`
      : "",
    "This is exactly what I read before every task — not a summary of it.",
  ].join("\n");
}

/**
 * `/audit` — what Nell did, and whether the record of it is intact.
 *
 * Worth a command rather than a dashboard-only view, because the audit log is
 * one of this project's headline claims and a claim nobody can check from where
 * they are standing is a claim. The chain is verified on every read rather than
 * behind a button: a log that reports "valid" only when asked nicely is not
 * doing the job.
 */
/**
 * Deleting things, with a confirmation and a receipt.
 *
 * The confirmation is the whole reason this is two steps. Every other command
 * here is recoverable — a forgotten note can be written again, a cancelled
 * schedule re-made — and this one is not. A `/delete` that acted on the first
 * message would eventually be typed by somebody exploring what the commands do.
 *
 * The token is the scope name repeated back. Not a yes/no: "yes" answers
 * whatever question was last asked, and the last question is not always this
 * one. Typing `history` is unambiguous about what is being agreed to.
 */
async function deleteCommand(
  options: NellOptions,
  scope: AccessScope,
  text: string
): Promise<string> {
  const parts = text.split(/\s+/u).slice(1);
  const asked = parts[0]?.toLowerCase();
  const confirmed = parts[1]?.toLowerCase();

  const scopes = deletionScopeSchema.options;
  if (!asked || !scopes.includes(asked as (typeof scopes)[number])) {
    return [
      "What should I delete?",
      "",
      "• /delete memory — what I have learned about you: preferences and rules",
      "• /delete history — the record of tasks I have done",
      "• /delete account — everything, including your vault",
      "",
      "Nothing happens until you confirm. Your audit log is never deleted: it " +
        "records that things happened, not what they were about.",
    ].join("\n");
  }

  const what = asked as (typeof scopes)[number];

  if (confirmed !== what) {
    const categories = plan(what);
    return [
      `That deletes ${categories.join(", ")} — permanently, with no undo.`,
      "",
      // The scope repeated back rather than "yes": a bare yes answers whichever
      // question was asked most recently, and that is not always this one.
      `Send \`/delete ${what} ${what}\` to go ahead.`,
    ].join("\n");
  }

  const requestedAt = Date.now();
  const outcome = await withWorkspace(options.pool, scope, (client) =>
    deleteScope(client, scope, what, requestedAt)
  );

  /**
   * Written down, because a deletion is exactly the kind of thing somebody
   * needs to be able to prove later — and because the chain surviving it is
   * what makes the receipt worth anything.
   */
  await options.recordDeletion?.(scope, outcome.receipt);

  return renderReceipt(outcome);
}

/**
 * Searching what Nell knows, rather than reading all of it.
 *
 * `renderBrain` prints everything, which is right when the model reads it and
 * wrong when a person asks a question. The recall index has existed since v2 —
 * rarity-weighted term matching, recency decay, an embedding seam — and had no
 * caller, so the one thing it is for was unreachable.
 *
 * The index is built per query rather than stored. That is not a shortcut: it is
 * the property the whole design rests on — an entry that cannot name a live
 * source does not exist, so deleting the source deletes the derived copy **by
 * construction**, with no sweep to remember and no cascade to get right.
 */
async function recallCommand(
  options: NellOptions,
  scope: AccessScope,
  text: string
): Promise<string> {
  const query = text.slice("/recall".length).trim();
  if (!query) return "What should I look for? Try `/recall flights to Delhi`.";

  const sources = await withWorkspace(options.pool, scope, (client) =>
    memorySources(client, scope)
  );
  if (sources.length === 0) return "I have not learned anything about you yet.";

  const index = await buildIndex(sources);
  const hits = searchMemory(index, query, { now: Date.now() });

  return hits.length === 0 ? `Nothing I know bears on "${query}".` : renderRecalled(hits);
}

/**
 * One entry per goal, whether the goal took one message or three.
 *
 * A follow-on folds into the row it continues; anything else writes its own. The
 * fold degrades to a new entry when there is nothing to extend — a continuation
 * of a goal whose row has since been deleted is simply a new goal, and refusing
 * to record it would lose the work entirely.
 */
async function recordFor(
  client: Parameters<typeof recordOutcome>[0],
  scope: AccessScope,
  continues: boolean,
  input: Parameters<typeof recordOutcome>[2]
): Promise<void> {
  if (continues && (await extendOutcome(client, scope, input))) return;
  await recordOutcome(client, scope, input);
}

async function auditCommand(options: NellOptions, scope: AccessScope): Promise<string> {
  if (!options.audit) return "This install is not keeping an audit log.";

  const view = await options.audit(scope);
  if (view.total === 0) {
    return [
      "Nothing recorded yet. I write down anything consequential — a stored password",
      "typed into a page, a spend refused, an action blocked by policy — and chain each",
      "entry to the one before it, so an edit to the record shows up.",
    ].join("\n");
  }

  /**
   * The verification result comes first, before the entries.
   *
   * If the chain is broken, that is the only thing on this screen worth reading,
   * and putting it under twenty lines of history is how it gets missed.
   */
  const header = view.valid
    ? `${String(view.total)} recorded, and the chain verifies.`
    : `⚠️ The record has been altered — it stops verifying at entry ${String(view.brokenAt ?? 0)}.${
        view.reason ? ` ${view.reason}` : ""
      }`;

  return [
    header,
    "",
    ...view.entries.map((entry) => {
      const when = new Date(entry.at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${String(entry.sequence)}. ${when} — ${describeAudit(entry.action)} · ${entry.subject.slice(0, 60)}`;
    }),
  ].join("\n");
}

/** Plain words for an action name, since the enum is written for code. */
function describeAudit(action: string): string {
  switch (action) {
    case "vault.fill":
      return "filled a saved credential";
    case "secret.decrypt":
      return "decrypted a secret";
    case "secret.write":
      return "saved a secret";
    case "secret.delete":
      return "forgot a secret";
    case "approval.mint":
      return "asked you to approve a payment";
    case "approval.spend":
      return "spent against an approval";
    case "purchase.execute":
      return "completed a purchase";
    case "message.outbound":
      return "sent a message";
    case "policy.deny":
      return "refused an action";
    case "monitor.fire":
      return "ran something on a schedule";
    default:
      return action;
  }
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
     * `/vault add`, `/vault add card`, `/vault add united.com`.
     *
     * The word after `add` is either which of the four sections they mean or the
     * site a login is for, and telling them apart by looking is better than
     * making somebody remember an order. The tabs on the page cover a wrong
     * guess in one click, so this only has to be right most of the time.
     */
    const asked = rest[0]?.toLowerCase() ?? "";
    const section = FORMS.find(
      (candidate) => candidate.kind === asked || candidate.section.toLowerCase() === asked
    );
    const site = section ? rest[1] : rest[0];
    const known = await vault.knownAccount(scope).catch(() => undefined);

    /**
     * Minted only when asked for, and it expires.
     *
     * A standing URL that adds credentials to your vault is a standing URL that
     * adds credentials to your vault, and it would sit in a chat history forever.
     */
    const url = vault.link(scope, site, known, section?.kind);
    return [
      `Open this on the computer I'm running on: ${url}`,
      "",
      "Logins, addresses, cards and phone numbers — the tabs at the top switch between",
      "them. It works once and expires in ten minutes. Typing a password there instead",
      "of here keeps it out of this chat entirely.",
    ].join("\n");
  }

  /**
   * The order the user sees, computed once and used by both the listing and the
   * deletion.
   *
   * Numbering a grouped list while resolving numbers against an ungrouped one is
   * a silent off-by-however-many — `/vault forget 3` would delete whatever
   * happened to be third alphabetically, report the wrong label cheerfully, and
   * the person would not find out until a task failed to sign in. Nearly
   * introduced exactly that by grouping the display and leaving this alone.
   */
  const ordered = FORMS.flatMap((section) => items.filter((item) => item.kind === section.kind));

  if (verb.toLowerCase() === "forget") {
    const index = Number(rest[0]);
    const target = Number.isInteger(index) ? ordered[index - 1] : undefined;
    if (!target) return "Send /vault to see the list, then /vault forget with a number from it.";
    const gone = await vault.forget(scope, target.id);
    return gone ? `Forgotten: ${target.label}.` : "That one was already gone.";
  }

  if (items.length === 0) {
    return [
      "Nothing saved yet. Four things I can keep: logins, addresses, cards and phone",
      "numbers — the things a checkout or a booking form asks for.",
      "",
      "Send /vault add and I'll give you a link to type them into, so they never go",
      "through this chat. Once a login is saved I can sign in to that site myself: I",
      "only ever see a label, and the password is typed into the page without passing",
      "through me.",
    ].join("\n");
  }

  /**
   * Grouped by section, numbered straight through.
   *
   * The numbers run across the whole list rather than restarting per section, so
   * `/vault forget 3` means one thing. Restarting them would put two items on
   * the same number, and the cost of picking wrong here is deleting a credential
   * somebody has to go and find again.
   */
  const lines: string[] = [];
  let heading = "";
  for (const [position, item] of ordered.entries()) {
    const section = FORMS.find((candidate) => candidate.kind === item.kind);
    if (section && section.section !== heading) {
      heading = section.section;
      if (lines.length > 0) lines.push("");
      lines.push(`${heading}:`);
    }
    const where = item.origins.map((origin) => origin.replace(/^https?:\/\//u, "")).join(", ");
    lines.push(
      `${String(position + 1)}. ${item.label}${item.accountHint ? ` — ${item.accountHint}` : ""}${
        where ? ` (${where})` : ""
      }`
    );
  }
  lines.push("");

  return [...lines, "/vault add to store another · /vault forget <number> to remove one."].join(
    "\n"
  );
}

/**
 * A task that is currently running, and the way to talk to it.
 *
 * Held so an inbound message can reach work already in progress rather than
 * queueing behind it — which is the difference between an assistant and a form
 * submission.
 */
/**
 * How many tasks may be in flight for one process.
 *
 * A cost bound rather than a safety one — safety is `withMachine`, which keeps
 * two browse steps off one browser. Three lets "look up two things while
 * booking a third" work without a burst of messages opening a dozen model
 * conversations at once.
 */
export const MAX_CONCURRENT_TASKS = 3;

interface Running {
  readonly workspaceId: string;
  /** Resolves when the task finishes, however it finishes. */
  readonly done: Promise<unknown>;
  /** The task itself, so the router can decide what a message is about. */
  readonly task: Task;
  /** Drained by the loop at the start of each turn. */
  readonly steering: Steer[];
  /**
   * The goal as it stands *now*, which a redirect changes.
   *
   * Held here as well as inside the loop because the classifier needs it: "not
   * that one" cannot be judged against the request the user typed ten minutes
   * and one change of mind ago.
   */
  objective: string;
  /**
   * A little of what the task has lately been doing.
   *
   * Without it a correction is unjudgeable. *"Not that theatre"* names something
   * only visible in the last few steps, and a classifier shown the objective
   * alone would have to guess which theatre it had reached.
   */
  readonly recent: string[];
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
  /**
   * Tasks in flight, keyed by their own id.
   *
   * A map rather than a single slot, because "ask for two things and get two
   * things" is the difference between an assistant and a queue. What stops
   * them colliding is not this — it is `withMachine`, which serialises the one
   * resource they genuinely share.
   */
  const running = new Map<string, Running>();
  let waiting: AwaitingApproval | undefined;
  /**
   * Distinguishes two tasks started from the same chat.
   *
   * The thread ref alone is not a key once tasks overlap — two requests in one
   * Telegram chat would collide on it, and the second would silently replace
   * the first in the map, leaving the first unroutable and unstoppable.
   */
  let nextTaskNumber = 1;

  /**
   * Whether this chat can have per-task threads at all.
   *
   * Starts hopeful and is turned off by the first refusal. Telegram allows
   * forum topics only in a forum-enabled supergroup, so a private chat with the
   * bot never gets them — and asking again for every task would be one failing
   * API call per request, for ever.
   */
  let topicsWork = true;

  /**
   * Resolved once for the poll loop, which needs a model of its own.
   *
   * Deciding what a mid-task message *wants* is a judgement, and the poll loop
   * is where mid-task messages arrive. Absent when nothing is configured, in
   * which case a correction falls back to being a constraint — the least
   * destructive reading, and what every correction used to be.
   */
  const router = providerFor(options.modelId, options.keys);

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

        const workspace = message.userId
          ? accessScopeForUser(message.userId).workspaceId
          : undefined;
        const mine = workspace
          ? [...running.values()].filter((task) => task.workspaceId === workspace)
          : [];

        if (mine.length > 0) {
          /**
           * "Stop" is unambiguous and immediate.
           *
           * Every other message is routed, but this one cannot wait for the next
           * turn to be considered — the whole point of saying it is that
           * something is going wrong now.
           */
          if (/^(stop|cancel|abort|never ?mind)\b/iu.test(text)) {
            // Everything of theirs. With several in flight, "stop" said in
            // alarm means all of it — asking which would be the wrong question
            // at the wrong moment.
            for (const task of mine) task.abort.abort();
            log(`  ! stopped ${String(mine.length)} by user`);
            await sendMessage({
              token: options.telegramToken,
              chatId: message.envelope.threadRef,
              text: mine.length > 1 ? `Stopping all ${String(mine.length)}.` : "Stopping.",
            });
            continue;
          }

          /**
           * Is this a correction, or a different thing entirely?
           *
           * Everything used to be a correction. A message arriving while a task
           * ran was pushed into it unconditionally, so asking *"what's the
           * weather?"* during a flight booking became a correction to the
           * booking — the request was lost and the task was told something
           * irrelevant about the weather.
           *
           * `routeMessage` was built in v1 to decide exactly this and had never
           * been called outside a package nothing imported. It answers
           * `coordinator` when nothing ties the message to a task, which is the
           * case this was getting wrong.
           */
          const target = routeMessage(
            { text },
            mine.map((task) => task.task),
            mine[0]!.workspaceId
          );

          if (target.kind === "task") {
            const steered = running.get(target.taskId);
            if (steered) {
              /**
               * Routing said *which* task. This says what to do about it.
               *
               * Everything landing here used to become one undifferentiated
               * thing — appended to a list of instructions beside an unchanged
               * objective. Watched live: told three times to abandon one cinema,
               * the agent hunted for it for another hundred steps, because a
               * correction arriving as one line cannot outvote an objective that
               * still names the place and a history full of looking for it.
               *
               * The three cases need opposite things done, which is why they can
               * no longer share a code path.
               */
              const intent: MidTaskIntent = router.ok
                ? await classifyMidTask(text, {
                    provider: router.provider,
                    model: options.modelId,
                    objective: steered.objective,
                    recently: steered.recent,
                  })
                : // No model, so the least destructive reading: a constraint
                  // keeps both the objective and the history.
                  { kind: "refine", constraint: text };

              if (intent.kind === "redirect") {
                steered.objective = intent.objective;
                steered.steering.push({ kind: "redirect", objective: intent.objective });
                log(`  ! redirect → "${intent.objective.slice(0, 60)}"`);
                continue;
              }

              if (intent.kind === "refine") {
                steered.steering.push({ kind: "refine", constraint: intent.constraint });
                log(`  ! steering "${steered.task.label.slice(0, 40)}"`);
                continue;
              }

              /**
               * The same request again, which means nothing looked like it was
               * happening. Starting a second copy is the worst answer: it
               * doubles the work and the first one is still going.
               */
              if (intent.kind === "repeat") {
                await sendMessage({
                  token: options.telegramToken,
                  chatId: message.envelope.threadRef,
                  text: `Still on it — ${steered.recent.at(-1) ?? "working"}.`,
                });
                log(`  ! repeat of a running task, told them`);
                continue;
              }

              /**
               * A new request, which falls through to the queue below — but is
               * acknowledged first.
               *
               * It was queued in silence, and from the other end that is
               * indistinguishable from being ignored. The user sent the same
               * thing twice and then said Nell was not listening; it was
               * listening, and had said nothing.
               */
              await sendMessage({
                token: options.telegramToken,
                chatId: message.envelope.threadRef,
                text: "Noted — I'll get to that once this is done.",
              });
            }
          }

          if (target.kind === "ambiguous") {
            /**
             * Asked rather than guessed, and the candidates are named.
             *
             * Sending someone's "yes" to the wrong task is the failure this
             * router exists to avoid, and with several in flight the question
             * is only answerable if it says which ones it is between.
             */
            const names = target.candidates
              .map((id) => running.get(id)?.task.label)
              .filter(Boolean)
              .map((label) => `"${String(label).slice(0, 40)}"`);
            await sendMessage({
              token: options.telegramToken,
              chatId: message.envelope.threadRef,
              text: `Is that about ${names.join(" or ")}, or something new?`,
            });
            continue;
          }
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
      if (running.size === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      else await Promise.race([...running.values()].map((task) => task.done));
      continue;
    }

    /**
     * Wait for a slot rather than refusing.
     *
     * The cap is about the model bill and the machine queue, not about
     * correctness — `withMachine` is what keeps two browse steps apart. Three is
     * enough that "look up two things while booking a third" works, and small
     * enough that a burst of messages cannot open a dozen model conversations at
     * once.
     */
    while (running.size >= MAX_CONCURRENT_TASKS) {
      await Promise.race([...running.values()].map((task) => task.done));
    }

    const abort = new AbortController();
    const steering: Steer[] = [];
    const workspaceId = message.userId ? accessScopeForUser(message.userId).workspaceId : undefined;

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

    const key = `${message.envelope.threadRef}:${String(nextTaskNumber++)}`;

    /** The last few progress notes, so a correction can be judged against them. */
    const recentNotes: string[] = [];

    /**
     * This task's own thread, opened once the request is known.
     *
     * Undefined until Telegram answers, and undefined for ever in a chat that
     * cannot have topics — which is most of them, since forums exist only in a
     * supergroup. Every reader of this treats undefined as "use the flat
     * thread", so the agent is unchanged outside a group rather than broken.
     */
    let topicId: number | undefined;

    /**
     * Opened before the handler runs, so even "On it." lands in the right place.
     *
     * Not awaited by the handler: a task must not wait on a group setting. If
     * Telegram is slow or refuses, the first message or two go to the flat
     * thread and the rest follow the topic, which is a better failure than
     * delaying the acknowledgement everybody is waiting for.
     */
    if (topicsWork) {
      void openForumTopic({
        token: options.telegramToken,
        chatId: message.envelope.threadRef,
        title: message.envelope.text.trim().slice(0, 100) || "Task",
      }).then((opened) => {
        if (opened === undefined) {
          // Asked once. A chat without forums will not grow them mid-session,
          // and retrying per task would be a failing API call per request.
          topicsWork = false;
          return;
        }
        topicId = opened;
      });
    }

    const done = handleMessage(options, message, {
      topicId: () => topicId,
      steering: () => steering.splice(0, steering.length),
      onNote: (note) => {
        recentNotes.push(note);
        // Bounded: the classifier reads the last handful, and an unbounded list
        // on a task doing 245 steps is a leak with no reader.
        if (recentNotes.length > 12) recentNotes.shift();
      },
      signal: abort.signal,
      onApprovalNeeded: (label, sessionId) => {
        if (workspaceId) waiting = { workspaceId, label, sessionId };
      },
      /**
       * Say which request an answer belongs to, but only when it is not
       * obvious.
       *
       * With one task in flight a prefix is noise. With two, an unlabelled
       * "Done — here are the flights" is a guess about which question it
       * answers, and the guess is the reader's to make.
       */
      ...(workspaceId
        ? {
            label: () =>
              [...running.values()].filter((task) => task.workspaceId === workspaceId).length > 1
                ? message.envelope.text.trim().slice(0, 40)
                : undefined,
          }
        : {}),
    })
      .catch((error: unknown) => {
        log(`  failed: ${error instanceof Error ? error.message : "unknown"}`);
        return undefined;
      })
      .finally(() => {
        running.delete(key);
        // Tidied away, so a long-lived group does not accumulate a topic per
        // request ever made. Failure is silent: an open topic is untidy, not broken.
        if (topicId !== undefined) {
          void closeForumTopic({
            token: options.telegramToken,
            chatId: message.envelope.threadRef,
            topicId,
          });
        }
      });

    if (workspaceId) {
      running.set(key, {
        workspaceId,
        steering,
        // What they asked for, until they change it.
        objective: message.envelope.text.trim(),
        recent: recentNotes,
        abort,
        done,
        task: {
          id: key,
          workspaceId,
          // The request itself is the label the router matches against, and the
          // only description of this task that exists while it runs.
          label: message.envelope.text.trim().slice(0, 120),
          status: "running" as const,
          spentAmount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
    } else {
      // A stranger's message still has to be answered, and never becomes a task.
      await done;
    }
  }

  // Nothing in flight is abandoned on shutdown: a task that was mid-booking
  // deserves to finish or to fail, not to vanish with the process.
  await Promise.allSettled([...running.values()].map((task) => task.done));

  await polling;
}
