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

const CONSEQUENTIAL: ReadonlySet<ToolClass> = new Set<ToolClass>([
  "spend",
  "send-message",
  "use-credential",
  "write-memory",
  "manage-monitor",
  "delete-data",
]);

export function isConsequential(tool: ToolClass): boolean {
  return CONSEQUENTIAL.has(tool);
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

export function authorizeTool(context: TurnContext, tool: ToolClass): GateDecision {
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
