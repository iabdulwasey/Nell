/**
 * Page perception: how a worker sees a page.
 *
 * The default is a filtered accessibility snapshot; pixels are an escalation.
 * That ordering is chosen for correctness and latency, not primarily for cost:
 *
 * - **Failure mode.** A version-stamped ref that goes stale raises an error. A
 *   stale coordinate clicks whatever moved into that spot — silently, and on a
 *   checkout page that is a wrong purchase rather than a caught mistake.
 * - **Latency.** Measured DOM-first agents finish a task in ~68s against
 *   ~285-330s for pixel-driven ones. For a product whose promise is "text it
 *   like a sharp friend", four minutes of extra silence is a different product.
 * - **Accuracy.** The gap is now narrow (ComponentBench: 83.8% pixel vs 81.5%
 *   accessibility-tree on the same model), so accuracy alone does not decide
 *   this. Safety and latency do.
 *
 * On cost, an earlier and widely-repeated 45x figure compared an *unbatched*
 * pixel loop against a *batched* structured one, and does not reproduce against
 * current tooling. Batching is the larger lever; perception mode is a further
 * ~2-3x on tokens. Worth having, not worth deciding the architecture on.
 *
 * The snapshot is deliberately lossy. Raw HTML is worse than a screenshot:
 * enormous, mostly irrelevant, and full of markup that invites reasoning about
 * implementation instead of intent. A worker gets the interaction surface —
 * what can be clicked, typed into, and read — with stable references.
 */

import { z } from "zod";

/** A single interactable or informative node. */
export interface SnapshotNode {
  /** Stable handle the worker uses to act on this node. */
  readonly ref: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
}

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly nodes: readonly SnapshotNode[];
  /** Visible prose, trimmed. Present when the task needs to read rather than act. */
  readonly text?: string;
  readonly truncated: boolean;
}

/** Roles worth showing a model. Everything else is layout noise. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "menuitem",
  "option",
  "tab",
]);

const INFORMATIVE_ROLES = new Set(["heading", "alert", "status", "dialog", "table", "listitem"]);

export function isWorthShowing(role: string): boolean {
  return INTERACTIVE_ROLES.has(role) || INFORMATIVE_ROLES.has(role);
}

export function isInteractive(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

/** Node budget per snapshot. Beyond this a page is navigated, not comprehended. */
export const MAX_NODES = 150;
export const MAX_TEXT_CHARS = 8000;

export interface BuildSnapshotInput {
  readonly url: string;
  readonly title: string;
  readonly candidates: readonly SnapshotNode[];
  readonly text?: string;
  readonly maxNodes?: number;
}

/**
 * Build the snapshot a model actually sees.
 *
 * Filters to the interaction surface and truncates rather than paying for a
 * thousand-node page. Interactive nodes are kept ahead of informative ones: on
 * a huge page, being able to act matters more than being able to read.
 */
export function buildSnapshot(input: BuildSnapshotInput): PageSnapshot {
  const limit = input.maxNodes ?? MAX_NODES;

  const worthShowing = input.candidates.filter((node) => isWorthShowing(node.role));
  const ordered = [
    ...worthShowing.filter((node) => isInteractive(node.role)),
    ...worthShowing.filter((node) => !isInteractive(node.role)),
  ];

  const nodes = ordered.slice(0, limit);
  const text = input.text ? input.text.slice(0, MAX_TEXT_CHARS) : undefined;

  return {
    url: input.url,
    title: input.title,
    nodes,
    text,
    truncated: ordered.length > limit || (input.text?.length ?? 0) > MAX_TEXT_CHARS,
  };
}

/** Render a snapshot for a prompt. Compact by construction. */
export function renderSnapshot(snapshot: PageSnapshot): string {
  const lines = snapshot.nodes.map((node) => {
    const parts = [`[${node.ref}]`, node.role];
    if (node.name) parts.push(`"${node.name}"`);
    if (node.value) parts.push(`= ${node.value}`);
    if (node.disabled) parts.push("(disabled)");
    if (node.checked !== undefined) parts.push(node.checked ? "(checked)" : "(unchecked)");
    return parts.join(" ");
  });

  const header = `${snapshot.title} — ${snapshot.url}`;
  const body = lines.join("\n");
  const note = snapshot.truncated ? "\n\n(page truncated; scroll or narrow the view)" : "";
  const text = snapshot.text ? `\n\n${snapshot.text}` : "";

  return `${header}\n\n${body}${text}${note}`;
}

/** Why a worker escalated from a snapshot to a screenshot. */
export type VisionReason =
  | "no-interactive-nodes"
  | "repeated-failure"
  | "visual-task"
  | "canvas-or-image"
  | "explicit-request";

export interface PerceptionDecision {
  readonly mode: "snapshot" | "vision";
  readonly reason?: VisionReason;
}

export interface PerceptionInput {
  readonly snapshot: PageSnapshot;
  /** Consecutive failed attempts on this page. */
  readonly failureCount: number;
  /** The task inherently needs to see (a seat map, a chart, a photo). */
  readonly visualTask?: boolean;
  /** The page's content is a canvas or image with no accessible structure. */
  readonly opaqueContent?: boolean;
  readonly explicitRequest?: boolean;
}

/** Failures on one page before falling back to vision. */
export const VISION_AFTER_FAILURES = 2;

/**
 * Choose how to look at the page.
 *
 * Escalation is bounded and evidence-based: a page that exposes no way to act,
 * or one where the structured approach has demonstrably failed twice, earns a
 * screenshot. Preference alone does not.
 */
export function choosePerception(input: PerceptionInput): PerceptionDecision {
  if (input.explicitRequest) return { mode: "vision", reason: "explicit-request" };
  if (input.visualTask) return { mode: "vision", reason: "visual-task" };
  if (input.opaqueContent) return { mode: "vision", reason: "canvas-or-image" };

  // A page with nothing actionable in its accessibility tree is one we cannot
  // drive structurally, whatever the markup claims.
  const actionable = input.snapshot.nodes.filter((node) => isInteractive(node.role));
  if (actionable.length === 0) return { mode: "vision", reason: "no-interactive-nodes" };

  if (input.failureCount >= VISION_AFTER_FAILURES) {
    return { mode: "vision", reason: "repeated-failure" };
  }

  return { mode: "snapshot" };
}

/**
 * Rough token cost of each mode, for metering and for the eval harness to
 * report honestly. A screenshot is priced at its image-token cost; a snapshot at
 * its rendered length.
 */
export const SCREENSHOT_TOKENS = 1400;

export function estimateTokens(mode: PerceptionDecision["mode"], snapshot: PageSnapshot): number {
  if (mode === "vision") return SCREENSHOT_TOKENS;
  // ~4 characters per token is close enough for budgeting.
  return Math.ceil(renderSnapshot(snapshot).length / 4);
}

export const snapshotNodeSchema = z.object({
  ref: z.string().min(1),
  role: z.string().min(1),
  name: z.string().optional(),
  value: z.string().optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
});
