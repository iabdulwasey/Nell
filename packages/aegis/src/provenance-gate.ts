/**
 * Provenance gate.
 *
 * A turn whose newly-introduced context is untrusted-only (an email body, page
 * text, a message from a stranger) cannot invoke a consequential tool without a
 * fresh user confirmation. The attacker's email may say whatever it likes; the
 * dispatcher simply refuses to act on it.
 *
 * This is enforced where tools execute, not in the prompt — so it holds even
 * when the model is completely convinced.
 */

import type { Provenance } from "@nell/shared";

/**
 * Tools that change the world or touch secrets. Reading and searching are not
 * consequential; spending, sending, and credential use are.
 */
export type ToolClass =
  | "read"
  | "search"
  | "spend"
  | "send-message"
  | "use-credential"
  | "write-memory"
  | "manage-monitor"
  | "delete-data";

/**
 * The tools that are safe to invoke on untrusted say-so, enumerated exhaustively.
 *
 * Deliberately inverted. Listing the *dangerous* tools instead reads more
 * naturally and fails in the worst possible direction: a tool class added to the
 * union and forgotten here would be waved through, and so would any tool name
 * that reached this function as a runtime string rather than a checked literal.
 * Both are silent, and both look exactly like everything working.
 *
 * Listing the safe ones means the mistake points the other way. A new tool
 * starts out requiring a trusted basis, and someone has to deliberately decide
 * it is harmless. Being wrong then costs a confirmation prompt instead of an
 * unauthorized action.
 */
const SAFE: ReadonlySet<string> = new Set<ToolClass>(["read", "search"]);

/**
 * Accepts an arbitrary string, not just a `ToolClass`. The type union is a
 * compile-time guarantee and tool names do not always arrive at compile time —
 * a registry lookup or a model-supplied name is a string, and an unrecognised
 * one must be treated as dangerous rather than as safe by default.
 */
export function isConsequential(tool: ToolClass | (string & {})): boolean {
  return !SAFE.has(tool);
}

export interface TurnContext {
  /** Provenance of everything newly introduced into this turn. */
  readonly newContext: readonly Provenance[];
  /**
   * True when the user explicitly confirmed this specific action during this
   * turn (a tapped approval, not merely an earlier unrelated message).
   */
  readonly userConfirmed: boolean;
}

export type GateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly needsConfirmation: boolean };

export function authorizeTool(context: TurnContext, tool: ToolClass | (string & {})): GateDecision {
  if (!isConsequential(tool)) return { allowed: true };
  if (context.userConfirmed) return { allowed: true };

  const hasTrustedBasis = context.newContext.some((provenance) => provenance !== "untrusted");

  if (hasTrustedBasis) return { allowed: true };

  return {
    allowed: false,
    needsConfirmation: true,
    reason:
      "This action was requested only by third-party content (for example an email or web page), so it needs your explicit confirmation first.",
  };
}
