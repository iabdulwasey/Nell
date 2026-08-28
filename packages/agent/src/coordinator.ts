/**
 * Coordinator turn loop.
 *
 * One coordinator per workspace owns the relationship: it receives every inbound
 * message, decides whether to answer directly or dispatch work, composes worker
 * briefings, and turns worker results back into something worth saying.
 *
 * It deliberately does not drive browsers or handle secrets. Keeping the
 * long-lived, context-rich agent away from tools that touch money and
 * credentials means a compromise of the conversation is not a compromise of the
 * vault.
 *
 * The loop is written as a pure decision function over durable state. Effects
 * (spawning a workflow, sending a message) are returned as instructions for the
 * caller to execute, which is what makes the whole thing testable and what lets
 * the durable engine replay it safely.
 */

import type { Directive, LedgerEntry, Preference } from "@nell/memory";
import { composeBriefing, type Briefing, type VaultHandle } from "./briefing.js";
import { routeMessage, type InboundMessage, type ProgressEvent } from "./steering.js";
import { admit, transition, type Task, type TaskStatus } from "./tasks.js";

/** What the coordinator wants done. The caller performs these. */
export type Effect =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "ask"; readonly text: string; readonly choices?: readonly string[] }
  | {
      readonly kind: "spawn-worker";
      readonly taskId: string;
      readonly briefing: Briefing;
    }
  | { readonly kind: "steer-worker"; readonly taskId: string; readonly message: string }
  | { readonly kind: "update-task"; readonly taskId: string; readonly status: TaskStatus }
  | { readonly kind: "record-outcome"; readonly taskId: string; readonly summary: string };

export interface CoordinatorState {
  readonly workspaceId: string;
  readonly tasks: readonly Task[];
  readonly directives: readonly Directive[];
  readonly preferences: readonly Preference[];
  readonly ledger: readonly LedgerEntry[];
  readonly vaultHandles: readonly VaultHandle[];
  readonly concurrency?: number;
}

/**
 * What the planner decided this message means. Supplied by the caller (which
 * runs the model) so this module stays deterministic and testable.
 */
export type Intent =
  | { readonly kind: "conversation"; readonly reply: string }
  | {
      readonly kind: "new-task";
      readonly label: string;
      readonly emoji?: string;
      readonly objective: string;
      readonly merchant?: string;
    }
  | { readonly kind: "steer"; readonly taskId: string; readonly message: string }
  | { readonly kind: "cancel"; readonly taskId: string };

export interface HandleMessageInput {
  readonly state: CoordinatorState;
  readonly message: InboundMessage;
  readonly intent: Intent;
  readonly newTaskId: string;
  readonly now: number;
}

/**
 * Handle one inbound message.
 *
 * Routing runs before intent is applied: if the message clearly belongs to a
 * running task, it is steering for that task regardless of what the planner
 * thought in isolation.
 */
export function handleMessage(input: HandleMessageInput): readonly Effect[] {
  const { state, message, intent, now } = input;
  const target = routeMessage(message, state.tasks, state.workspaceId);

  // Ambiguity is resolved by asking, never by picking. Sending someone's "yes"
  // to the wrong purchase is the failure mode this exists to prevent.
  if (target.kind === "ambiguous") {
    const labels = target.candidates
      .map((id) => state.tasks.find((task) => task.id === id)?.label ?? id)
      .filter(Boolean);
    return [
      {
        kind: "ask",
        text: `Which one do you mean?`,
        choices: labels,
      },
    ];
  }

  // A message routed to a live task is steering for it.
  if (target.kind === "task") {
    if (intent.kind === "cancel") {
      return cancelTask(state, target.taskId, now);
    }
    return [{ kind: "steer-worker", taskId: target.taskId, message: message.text }];
  }

  switch (intent.kind) {
    case "conversation":
      return [{ kind: "reply", text: intent.reply }];

    case "cancel":
      return cancelTask(state, intent.taskId, now);

    case "steer":
      return [{ kind: "steer-worker", taskId: intent.taskId, message: intent.message }];

    case "new-task":
      return startTask(input, intent);
  }
}

function cancelTask(state: CoordinatorState, taskId: string, now: number): readonly Effect[] {
  const task = state.tasks.find(
    (candidate) => candidate.id === taskId && candidate.workspaceId === state.workspaceId
  );
  if (!task) return [{ kind: "reply", text: "I couldn't find that task." }];

  const result = transition(task, "cancelled", now);
  if (!result.ok) {
    return [{ kind: "reply", text: `That task is already ${task.status}.` }];
  }
  return [
    { kind: "update-task", taskId, status: "cancelled" },
    { kind: "reply", text: `Stopped ${task.label}.` },
  ];
}

function startTask(
  input: HandleMessageInput,
  intent: Extract<Intent, { kind: "new-task" }>
): readonly Effect[] {
  const { state, newTaskId, now } = input;

  const queued: Task = {
    id: newTaskId,
    workspaceId: state.workspaceId,
    label: intent.label,
    emoji: intent.emoji,
    status: "queued",
    spentAmount: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Respect the concurrency cap: a burst must queue rather than starve
  // everything already running.
  const admitted = admit([...state.tasks, queued], state.workspaceId, state.concurrency);
  const startsNow = admitted.some((task) => task.id === newTaskId);

  if (!startsNow) {
    return [
      { kind: "update-task", taskId: newTaskId, status: "queued" },
      {
        kind: "reply",
        text: `Queued ${intent.label} — I'll start it as soon as something frees up.`,
      },
    ];
  }

  const briefing = composeBriefing({
    workspaceId: state.workspaceId,
    taskId: newTaskId,
    objective: intent.objective,
    directives: state.directives,
    preferences: state.preferences,
    ledger: state.ledger,
    vaultHandles: state.vaultHandles,
    merchant: intent.merchant,
  });

  return [
    { kind: "update-task", taskId: newTaskId, status: "running" },
    { kind: "spawn-worker", taskId: newTaskId, briefing },
    { kind: "reply", text: `On it — ${intent.label}.` },
  ];
}

/** How a worker finished. */
export interface WorkerResult {
  readonly taskId: string;
  readonly outcome: "succeeded" | "failed" | "blocked";
  /** What to tell the user. Already user-facing prose. */
  readonly summary: string;
  /** Present when blocked: what the agent needs from the user. */
  readonly question?: string;
  readonly choices?: readonly string[];
}

/**
 * Turn a worker result into user-facing effects and the next task state.
 *
 * A blocked worker is not a failure — it is waiting on a person, and the task
 * stays alive so the answer can resume it.
 */
export function handleWorkerResult(
  state: CoordinatorState,
  result: WorkerResult,
  now: number
): readonly Effect[] {
  const task = state.tasks.find(
    (candidate) => candidate.id === result.taskId && candidate.workspaceId === state.workspaceId
  );
  if (!task) return [];

  if (result.outcome === "blocked") {
    const next = transition(task, "blocked-on-user", now);
    return [
      ...(next.ok
        ? [{ kind: "update-task", taskId: task.id, status: "blocked-on-user" } as const]
        : []),
      {
        kind: "ask",
        text: result.question ?? result.summary,
        choices: result.choices,
      },
    ];
  }

  const status: TaskStatus = result.outcome === "succeeded" ? "done" : "failed";
  const next = transition(task, status, now);

  return [
    ...(next.ok ? [{ kind: "update-task", taskId: task.id, status } as const] : []),
    { kind: "record-outcome", taskId: task.id, summary: result.summary },
    { kind: "reply", text: result.summary },
  ];
}

/**
 * Tasks that can start now that a slot has freed. Called after any task
 * reaches a terminal state, so a queue drains without needing a poller.
 */
export function drainQueue(
  state: CoordinatorState,
  now: number
): readonly Extract<Effect, { kind: "update-task" }>[] {
  return admit(state.tasks, state.workspaceId, state.concurrency).map((task) => ({
    kind: "update-task" as const,
    taskId: task.id,
    status: "running" as const,
  }));
}

/** Progress events a worker emitted, for the coalescer to batch. */
export function progressFrom(
  task: Task,
  message: string,
  now: number,
  interrupt = false
): ProgressEvent {
  return {
    taskId: task.id,
    label: task.label,
    emoji: task.emoji,
    message,
    at: now,
    interrupt,
  };
}
