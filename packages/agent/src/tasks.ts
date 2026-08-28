/**
 * Task registry.
 *
 * Every piece of work the agent is doing is a row here, which is what turns a
 * stream of chat messages into something the user (and the coordinator) can
 * actually see: what is running, what is blocked on them, what finished.
 *
 * Instinct's most-cited UX failure was multiplexing many concurrent jobs through
 * one undifferentiated message thread. Making tasks first-class entities — with
 * identity, status, and a budget — is the fix.
 */

import { z } from "zod";

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  /** Waiting on the user: an approval, a CAPTCHA, a missing detail. */
  "blocked-on-user",
  /** Waiting on the world: a monitor tick, a merchant, a delivery. */
  "blocked-on-world",
  "done",
  "failed",
  "cancelled",
]);

export type TaskStatus = z.infer<typeof taskStatusSchema>;

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  /** Short human label, used in digests and as the steering handle. */
  readonly label: string;
  readonly emoji?: string;
  readonly status: TaskStatus;
  readonly workflowId?: string;
  /** Spend ceiling in minor units; the policy engine enforces it. */
  readonly budgetAmount?: number;
  readonly spentAmount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A task is finished when it will never run again. */
const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "failed", "cancelled"]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export function isActive(task: Task): boolean {
  return !isTerminal(task.status);
}

/**
 * Legal status transitions. Encoded rather than left to callers so a task cannot
 * be resurrected after completion or skip from queued straight to done.
 */
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["blocked-on-user", "blocked-on-world", "done", "failed", "cancelled"],
  "blocked-on-user": ["running", "cancelled", "failed"],
  "blocked-on-world": ["running", "cancelled", "failed"],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type TransitionResult =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly reason: string };

export function transition(task: Task, to: TaskStatus, now: number): TransitionResult {
  if (!canTransition(task.status, to)) {
    return {
      ok: false,
      reason: `A ${task.status} task cannot become ${to}.`,
    };
  }
  return { ok: true, task: { ...task, status: to, updatedAt: now } };
}

/**
 * Per-workspace concurrency cap.
 *
 * Without it, a burst of requests starves everything — which is how a
 * latency-sensitive task (a ticket drop) loses because six other jobs are
 * competing for the same browser capacity.
 */
export const DEFAULT_CONCURRENCY = 3;

export function runningCount(tasks: readonly Task[], workspaceId: string): number {
  return tasks.filter((task) => task.workspaceId === workspaceId && task.status === "running")
    .length;
}

/** Which queued tasks may start now, oldest first. */
export function admit(
  tasks: readonly Task[],
  workspaceId: string,
  concurrency: number = DEFAULT_CONCURRENCY
): readonly Task[] {
  const slots = concurrency - runningCount(tasks, workspaceId);
  if (slots <= 0) return [];
  return tasks
    .filter((task) => task.workspaceId === workspaceId && task.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, slots);
}

export function activeTasks(tasks: readonly Task[], workspaceId: string): readonly Task[] {
  return tasks
    .filter((task) => task.workspaceId === workspaceId && isActive(task))
    .sort((a, b) => a.createdAt - b.createdAt);
}
