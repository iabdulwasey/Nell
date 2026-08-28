/**
 * Steering router and digest coalescing.
 *
 * When several tasks run at once over a single text thread, two problems appear:
 * inbound messages become ambiguous ("yes" — to which question?), and outbound
 * progress updates interleave into noise. This module handles both.
 *
 * Routing is deliberately deterministic first and model-assisted only as a last
 * resort: a reply to a specific message, or an explicit tag, is unambiguous
 * evidence and should never be second-guessed by a classifier.
 */

import type { Task } from "./tasks.js";
import { activeTasks } from "./tasks.js";

export type RouteTarget =
  | { readonly kind: "task"; readonly taskId: string; readonly confidence: "certain" | "likely" }
  | { readonly kind: "coordinator" }
  /** Genuinely ambiguous — ask rather than guess. */
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] };

export interface InboundMessage {
  readonly text: string;
  /** Provider-level reply linkage, when the channel supports it. */
  readonly replyToTaskId?: string;
  /** Channel-native thread (e.g. a Telegram forum topic) bound to a task. */
  readonly threadTaskId?: string;
}

/** `#tag` or `#3` referring to a task by label or position. */
function explicitTag(text: string): string | undefined {
  return /(?:^|\s)#([\w-]+)/u.exec(text)?.[1]?.toLowerCase();
}

/**
 * Route an inbound message.
 *
 * Order matters: strongest evidence first, and an ambiguous result is a valid
 * answer. Guessing wrong sends someone's "yes" to the wrong purchase.
 */
export function routeMessage(
  message: InboundMessage,
  tasks: readonly Task[],
  workspaceId: string
): RouteTarget {
  const active = activeTasks(tasks, workspaceId);

  // 1. A channel-native thread binding is unambiguous.
  if (message.threadTaskId && active.some((task) => task.id === message.threadTaskId)) {
    return { kind: "task", taskId: message.threadTaskId, confidence: "certain" };
  }

  // 2. An explicit reply is unambiguous.
  if (message.replyToTaskId && active.some((task) => task.id === message.replyToTaskId)) {
    return { kind: "task", taskId: message.replyToTaskId, confidence: "certain" };
  }

  // 3. An explicit #tag matching a task label.
  const tag = explicitTag(message.text);
  if (tag) {
    const tagged = active.filter((task) => slug(task.label).includes(tag));
    if (tagged.length === 1 && tagged[0]) {
      return { kind: "task", taskId: tagged[0].id, confidence: "certain" };
    }
  }

  // 4. Distinctive label words appearing in the message.
  const mentioned = active.filter((task) => mentions(message.text, task.label));
  if (mentioned.length === 1 && mentioned[0]) {
    return { kind: "task", taskId: mentioned[0].id, confidence: "likely" };
  }
  if (mentioned.length > 1) {
    return { kind: "ambiguous", candidates: mentioned.map((task) => task.id) };
  }

  // 5. A bare confirmation only makes sense against a task that asked something.
  if (isBareReply(message.text)) {
    const waiting = active.filter((task) => task.status === "blocked-on-user");
    if (waiting.length === 1 && waiting[0]) {
      return { kind: "task", taskId: waiting[0].id, confidence: "likely" };
    }
    if (waiting.length > 1) {
      return { kind: "ambiguous", candidates: waiting.map((task) => task.id) };
    }
  }

  return { kind: "coordinator" };
}

function slug(label: string): string {
  return label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

/** Words too common to identify a task by. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "for",
  "to",
  "at",
  "on",
  "in",
  "of",
  "and",
  "my",
  "me",
  "book",
  "buy",
  "get",
  "find",
  "order",
  "check",
]);

function mentions(text: string, label: string): boolean {
  const haystack = text.toLowerCase();
  const distinctive = label
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
  return distinctive.some((word) => haystack.includes(word));
}

const BARE_REPLIES = new Set([
  "yes",
  "y",
  "yep",
  "yeah",
  "ok",
  "okay",
  "sure",
  "confirm",
  "confirmed",
  "do it",
  "go ahead",
  "no",
  "n",
  "nope",
  "cancel",
  "stop",
]);

export function isBareReply(text: string): boolean {
  return BARE_REPLIES.has(text.trim().toLowerCase().replaceAll(/[.!]/gu, ""));
}

/**
 * Progress coalescing.
 *
 * Workers emit progress constantly. Delivering each one is how an assistant
 * turns into a firehose, so routine updates are batched into one digest per
 * quiet window and only interrupts are delivered immediately.
 */
export interface ProgressEvent {
  readonly taskId: string;
  readonly label: string;
  readonly emoji?: string;
  readonly message: string;
  readonly at: number;
  /** Approvals and hard blockers reach the user immediately. */
  readonly interrupt?: boolean;
}

export const QUIET_WINDOW_MS = 60 * 1000;

export interface CoalesceResult {
  /** Sent right now, one message each. */
  readonly immediate: readonly ProgressEvent[];
  /** Single combined message, or undefined when nothing is due. */
  readonly digest?: string;
  /** Events still waiting for the window to close. */
  readonly pending: readonly ProgressEvent[];
}

export function coalesce(
  events: readonly ProgressEvent[],
  now: number,
  windowMs: number = QUIET_WINDOW_MS
): CoalesceResult {
  const immediate = events.filter((event) => event.interrupt === true);
  const routine = events.filter((event) => event.interrupt !== true);

  // Hold routine updates until the oldest has waited out the window.
  const oldest = routine.reduce<number | undefined>(
    (min, event) => (min === undefined || event.at < min ? event.at : min),
    undefined
  );
  const windowClosed = oldest !== undefined && now - oldest >= windowMs;

  if (!windowClosed) {
    return { immediate, pending: routine };
  }

  // One line per task, newest state wins — nobody needs three updates about the
  // same job.
  const latestByTask = new Map<string, ProgressEvent>();
  for (const event of routine) {
    const existing = latestByTask.get(event.taskId);
    if (!existing || event.at > existing.at) latestByTask.set(event.taskId, event);
  }

  const digest = [...latestByTask.values()]
    .sort((a, b) => a.at - b.at)
    .map((event) => `${event.emoji ? `${event.emoji} ` : ""}${event.label}: ${event.message}`)
    .join("\n");

  return { immediate, digest: digest || undefined, pending: [] };
}
