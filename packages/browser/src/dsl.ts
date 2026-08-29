/**
 * Typed browser action DSL.
 *
 * The agent drives a browser through this closed vocabulary — never by authoring
 * code that the browser then executes. That is a deliberate boundary, not a
 * convenience: arbitrary code on a session that has had a credential typed into
 * it is an unbounded exfiltration channel (a secret can be encoded into a URL, a
 * timing pattern, or a DOM mutation, none of which a response scrubber can
 * catch). Removing the capability is a boundary; scrubbing it is a mitigation.
 *
 * Long-tail dexterity is recovered through vision fallback and reviewed,
 * server-side recipe scripts — never through model-authored code.
 */

import { z } from "zod";

/** How an element is addressed. Accessibility-first: stable and cheap. */
export const targetSchema = z.union([
  z.object({
    by: z.literal("role"),
    role: z.string().min(1).max(64),
    name: z.string().min(1).max(300).optional(),
    nth: z.number().int().nonnegative().max(50).optional(),
  }),
  z.object({ by: z.literal("label"), text: z.string().min(1).max(300) }),
  z.object({ by: z.literal("placeholder"), text: z.string().min(1).max(300) }),
  z.object({ by: z.literal("text"), text: z.string().min(1).max(300) }),
  z.object({ by: z.literal("testId"), id: z.string().min(1).max(200) }),
  /**
   * A reference from the current snapshot, e.g. `3:e7`.
   *
   * The preferred way to name an element, and the reason structured driving is
   * safer than coordinates: a ref from an earlier look matches nothing, so
   * acting on a page that moved fails loudly instead of clicking whatever
   * happens to be there now. Every other target here is a description that a
   * changed page can silently satisfy with the wrong element.
   */
  z.object({ by: z.literal("ref"), ref: z.string().regex(/^\d+:e\d+$/u) }),
  /**
   * CSS is the escape hatch. Bounded in length, and never a substitute for code
   * execution: it selects an element, it does not run anything.
   */
  z.object({
    by: z.literal("css"),
    selector: z
      .string()
      .min(1)
      .max(500)
      /**
       * A snapshot ref is not a CSS selector.
       *
       * Refs look like `1:e3`, and page listings used to render them bracketed,
       * so a model would send `{by: "css", selector: "[1:e3]"}` — which Chromium
       * rejects as invalid CSS, ending the task with a `querySelectorAll`
       * SyntaxError from deep inside Playwright. Caught here instead, with a
       * sentence naming the right addressing mode, because the model can act on
       * that and cannot act on a parser error.
       *
       * The listing no longer invites the mistake; this stays because the cost
       * of the check is nothing and the cost of the confusion was a whole task.
       */
      .refine((selector) => !/^\[?\d+:e\d+\]?$/u.test(selector.trim()), {
        message: 'That is a snapshot ref, not a CSS selector — use {"by":"ref","ref":"..."}.',
      }),
  }),
]);

export type Target = z.infer<typeof targetSchema>;

/**
 * Navigable URL. Restricted to http/https on purpose: `javascript:`, `data:`,
 * and `file:` are all technically valid URLs, and all three are ways to turn a
 * navigation into code execution or local-file access.
 */
const navigableUrlSchema = z.string().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}, "Navigation must be an http(s) URL.");

export const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("goto"),
    url: navigableUrlSchema,
    waitUntil: z.enum(["domcontentloaded", "load"]).default("domcontentloaded"),
  }),
  z.object({ action: z.literal("click"), target: targetSchema }),
  /**
   * Types a literal, non-secret value. Secrets never travel through this action
   * — they are injected server-side by the vault fill path, which the model
   * cannot invoke with a raw value.
   */
  z.object({
    action: z.literal("type"),
    target: targetSchema,
    text: z.string().max(2000),
    clearFirst: z.boolean().default(true),
  }),
  z.object({
    action: z.literal("select"),
    target: targetSchema,
    value: z.string().max(300),
  }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down"]),
    amount: z.number().int().positive().max(5000).default(600),
  }),
  z.object({
    action: z.literal("waitFor"),
    target: targetSchema,
    state: z.enum(["visible", "hidden"]).default("visible"),
    timeoutMs: z.number().int().positive().max(15_000).default(5000),
  }),
  z.object({ action: z.literal("back") }),
  /** Structured extraction: the model declares a shape, not a scraping script. */
  z.object({
    action: z.literal("extract"),
    target: targetSchema.optional(),
    fields: z.array(z.string().min(1).max(100)).min(1).max(30),
  }),
  z.object({ action: z.literal("screenshot"), fullPage: z.boolean().default(false) }),

  /**
   * Attach a file to a file input — CVs, ID documents, receipts. Files come from
   * the user's own uploads by reference; a worker cannot name an arbitrary path
   * on the host, which would otherwise be a filesystem read primitive.
   */
  z.object({
    action: z.literal("upload"),
    target: targetSchema,
    /** Reference to a file the user provided, never a filesystem path. */
    fileRef: z.string().min(1).max(200),
  }),

  /** Reveal menus and tooltips that only appear on hover. */
  z.object({ action: z.literal("hover"), target: targetSchema }),

  /** Drag one element onto another: sliders, reordering, some date pickers. */
  z.object({
    action: z.literal("drag"),
    from: targetSchema,
    to: targetSchema,
  }),

  /**
   * Press a key. Bounded to a known set: some flows are only reachable by
   * keyboard (Enter to submit, Escape to dismiss, Tab through a widget).
   */
  z.object({
    action: z.literal("press"),
    key: z.enum([
      "Enter",
      "Escape",
      "Tab",
      "Backspace",
      "Delete",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageDown",
      "PageUp",
      "Home",
      "End",
    ]),
  }),

  /**
   * Click at a coordinate. The escape hatch for canvas, maps and image-based
   * widgets that expose nothing to the accessibility tree. Deliberately last
   * and deliberately rare: coordinates break when layout shifts, which is why
   * they are not the primary way to act.
   */
  z.object({
    action: z.literal("click-at"),
    x: z.number().int().nonnegative().max(10_000),
    y: z.number().int().nonnegative().max(10_000),
  }),
]);

export type BrowserAction = z.infer<typeof actionSchema>;

/** Actions are submitted in bounded batches to keep round-trips low. */
export const actionBatchSchema = z.array(actionSchema).min(1).max(20);

/**
 * Map an action to the taint-machine operation class, so the policy engine can
 * decide whether it is permitted on a session holding a filled credential.
 */
export function operationClassOf(
  action: BrowserAction
):
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "wait"
  | "read-text"
  | "screenshot"
  | "upload" {
  switch (action.action) {
    case "goto":
    case "back":
      return "navigate";
    case "click":
      return "click";
    case "type":
      return "type";
    case "select":
      return "select";
    case "scroll":
      return "scroll";
    case "waitFor":
      return "wait";
    case "extract":
      return "read-text";
    case "screenshot":
      return "screenshot";
    // Attaching a file moves data OUT of the machine, so it is classified
    // separately: the taint machine must be able to refuse it on a session that
    // is holding a credential.
    case "upload":
      return "upload";
    case "hover":
    case "drag":
    case "click-at":
      return "click";
    case "press":
      return "type";
  }
}

/**
 * Reject targets that try to smuggle script execution through a CSS selector.
 * Belt and braces: the executor never evaluates these strings as code, but a
 * selector containing javascript: is a signal worth refusing outright.
 */
export function validateTarget(target: Target): void {
  if (target.by !== "css") return;
  if (/javascript:|<script|expression\(/iu.test(target.selector)) {
    throw new Error("Refusing a selector that looks like script injection.");
  }
}

export function parseActionBatch(input: unknown): BrowserAction[] {
  const actions = actionBatchSchema.parse(input);
  for (const action of actions) {
    if ("target" in action && action.target) validateTarget(action.target);
  }
  return actions;
}
