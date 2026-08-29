/**
 * Page perception: the second way a worker sees.
 *
 * A worker has two senses and picks between them freely. Pixels (see
 * `computer.ts`) are the general one: a screenshot works on every page ever
 * built, including the many that expose nothing useful to assistive technology.
 * This file provides the other — a filtered accessibility snapshot with stable
 * refs — which is narrower but, where it applies, strictly better:
 *
 * - **Failure mode.** A version-stamped ref that goes stale raises an error. A
 *   stale coordinate clicks whatever moved into that spot — silently, and on a
 *   checkout page that is a wrong purchase rather than a caught mistake.
 * - **Latency.** Measured DOM-driven agents finish a task in ~68s against
 *   ~285-330s for pixel-driven ones. That gap is invisible on a leisurely
 *   booking and decisive on a ticket drop, which is the case this sense exists
 *   for.
 * - **Accuracy.** Near parity (ComponentBench: 83.8% pixel vs 81.5%
 *   accessibility-tree on the same model), so accuracy does not pick a winner.
 *   Speed and failure mode do, and only on pages clean enough to have refs.
 *
 * On cost, an earlier and widely-repeated 45x figure compared an *unbatched*
 * pixel loop against a *batched* structured one, and does not reproduce against
 * current tooling. Batching is the larger lever; perception mode is a further
 * ~2-3x on tokens. Worth having, not worth deciding the architecture on.
 *
 * Neither sense gates the other. Whichever the worker uses, the action it
 * produces meets the same policy chokepoint — seeing differently never means
 * being allowed to do more.
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
  /**
   * How many elements the page actually had.
   *
   * Present so the model can be told the truth about what it is missing.
   * "Truncated" on its own invites guessing at the cause, and the guess that
   * cost a real task was "scroll to see the rest" — which cannot work, because
   * the whole page is already collected and the limit is a count, not a
   * viewport.
   */
  readonly totalNodes?: number;
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
    totalNodes: ordered.length,
  };
}

/**
 * What to say when the page did not fit.
 *
 * The previous note read "(page truncated; scroll or narrow the view)" and cost
 * a real task: the model scrolled three times, nothing changed, and the loop
 * declared it stuck. Scrolling could never have worked — every element on the
 * page is collected regardless of where the viewport is, so the limit is a
 * count and not a window onto the page.
 *
 * So the note says what is actually true and what actually helps. A hint that
 * suggests an impossible action is worse than no hint, because the model will
 * take it, and take it again.
 */
export function truncationNote(snapshot: PageSnapshot): string {
  const shown = snapshot.nodes.length;
  const total = snapshot.totalNodes ?? shown;

  return (
    `(showing ${String(shown)} of ${String(total)} elements — you are seeing the whole page, ` +
    `not just the visible part, so scrolling will not reveal more unless the site loads ` +
    `content as you scroll. To read past this, use extract.)`
  );
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
  const note = snapshot.truncated ? `\n\n${truncationNote(snapshot)}` : "";
  const text = snapshot.text ? `\n\n${snapshot.text}` : "";

  return `${header}\n\n${body}${text}${note}`;
}

/**
 * Why a particular sense was recommended.
 *
 * Both directions are represented, because neither sense is the exception any
 * more — a recommendation of `snapshot` is as much a decision as a
 * recommendation of `vision`, and a worker reviewing its own trace deserves to
 * know why it looked the way it did in both cases.
 */
export type PerceptionReason =
  /* → vision */
  | "no-interactive-nodes"
  | "repeated-failure"
  | "visual-task"
  | "canvas-or-image"
  | "explicit-request"
  | "general-purpose"
  /* → snapshot */
  | "time-critical"
  | "cleanly-drivable";

export interface PerceptionDecision {
  /** The sense to lead with. */
  readonly mode: "snapshot" | "vision";
  readonly reason: PerceptionReason;
  /**
   * The sense NOT chosen — always populated, because it is always available.
   * This field exists to make the contract unmissable at the call site: this
   * function recommends, it does not permit.
   */
  readonly alsoAvailable: "snapshot" | "vision";
}

export interface PerceptionInput {
  /**
   * Optional. A worker may act on pixels without ever building a snapshot, so
   * requiring one here would have quietly reimposed the gate this function had.
   */
  readonly snapshot?: PageSnapshot;
  /** Consecutive failed attempts on this page. */
  readonly failureCount: number;
  /** The task inherently needs to see (a seat map, a chart, a photo). */
  readonly visualTask?: boolean;
  /** The page's content is a canvas or image with no accessible structure. */
  readonly opaqueContent?: boolean;
  readonly explicitRequest?: boolean;
  /**
   * The task is racing something — a ticket drop, a countdown, a checkout hold.
   * Structured steps run several times faster, and a lost race is a lost task
   * however good the reasoning was.
   */
  readonly timeCritical?: boolean;
}

/** Structured failures on one page before pixels become the better lead. */
export const VISION_AFTER_FAILURES = 2;

/**
 * Recommend which sense to lead with.
 *
 * **This is advice, not permission.** Both senses are available at every step and
 * the worker may take either; an earlier design made vision unreachable until
 * the structured path had visibly failed twice, which meant burning two failures
 * before the agent was allowed to look at the screen. That gate is gone.
 *
 * The default is vision, because it is the general sense — it works on every
 * page ever built, including the ones that expose nothing to assistive tech.
 * Structured is recommended only where it is genuinely the better tool: a page
 * that is cleanly drivable, where refs are both faster (~68s/task against
 * ~285-330s measured for pixel loops) and safer (a stale ref raises; a stale
 * coordinate clicks whatever moved into that spot).
 */
export function choosePerception(input: PerceptionInput): PerceptionDecision {
  const vision = (reason: PerceptionReason): PerceptionDecision => ({
    mode: "vision",
    reason,
    alsoAvailable: "snapshot",
  });
  const structured = (reason: PerceptionReason): PerceptionDecision => ({
    mode: "snapshot",
    reason,
    alsoAvailable: "vision",
  });

  if (input.explicitRequest) return vision("explicit-request");
  if (input.visualTask) return vision("visual-task");
  if (input.opaqueContent) return vision("canvas-or-image");

  // A page with nothing actionable in its accessibility tree cannot be driven
  // structurally, whatever the markup claims.
  const actionable = (input.snapshot?.nodes ?? []).filter((node) => isInteractive(node.role));
  if (actionable.length === 0) return vision("no-interactive-nodes");

  if (input.failureCount >= VISION_AFTER_FAILURES) return vision("repeated-failure");

  // Racing a drop is the case where the speed difference decides the outcome
  // rather than merely the bill.
  if (input.timeCritical) return structured("time-critical");

  // A truncated page is one we are only seeing part of; leading with a
  // screenshot at least shows what is actually on screen.
  if (input.snapshot && !input.snapshot.truncated) return structured("cleanly-drivable");

  return vision("general-purpose");
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
