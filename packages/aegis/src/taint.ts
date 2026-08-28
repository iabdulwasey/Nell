/**
 * Session taint machine.
 *
 * After a secret is typed into a browser session, that session is TAINTED for
 * the secret's class until it commits a cross-origin navigation. While tainted,
 * value-returning operations are blocked or scrubbed: the agent can keep
 * clicking and navigating, but it cannot read the field back, read the
 * clipboard, download, or take an unmasked screenshot.
 *
 * Defense in depth: the primary boundary is that model-authored code cannot run
 * on a session at all (the typed action DSL). This machine is the second layer,
 * and it is what makes "the model must not read back the password" a runtime
 * property rather than a line in a prompt.
 */

export type BrowserOperation =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "wait"
  | "read-text"
  | "read-value"
  | "read-clipboard"
  | "screenshot"
  | "download";

export interface TaintState {
  readonly tainted: boolean;
  /** Origin the secret was filled on; taint clears when we leave it. */
  readonly origin?: string;
  /** Field selectors that received secret values, for scrubbing. */
  readonly filledSelectors: readonly string[];
}

export const UNTAINTED: TaintState = { tainted: false, filledSelectors: [] };

export function markFilled(
  state: TaintState,
  origin: string,
  selectors: readonly string[]
): TaintState {
  return {
    tainted: true,
    origin,
    filledSelectors: [...new Set([...state.filledSelectors, ...selectors])],
  };
}

/** Taint clears once the session commits to a different origin. */
export function afterNavigation(state: TaintState, newOrigin: string): TaintState {
  if (!state.tainted) return state;
  return state.origin === newOrigin ? state : UNTAINTED;
}

export type OperationDecision =
  | { readonly allowed: true; readonly scrub: boolean }
  | { readonly allowed: false; readonly reason: string };

/**
 * Operations that could carry a secret value back to the model. `read-text` is
 * permitted but scrubbed (page text is needed to navigate); `read-value`,
 * clipboard, and downloads are refused outright while tainted.
 */
export function authorizeOperation(
  state: TaintState,
  operation: BrowserOperation
): OperationDecision {
  if (!state.tainted) return { allowed: true, scrub: false };

  switch (operation) {
    case "read-value":
      return {
        allowed: false,
        reason: "Reading field values is blocked after a credential fill on this page.",
      };
    case "read-clipboard":
      return {
        allowed: false,
        reason: "Clipboard access is blocked after a credential fill.",
      };
    case "download":
      return {
        allowed: false,
        reason: "Downloads are blocked after a credential fill.",
      };
    case "read-text":
    case "screenshot":
      // Allowed, but the caller must scrub/mask the filled fields first.
      return { allowed: true, scrub: true };
    case "navigate":
    case "click":
    case "type":
    case "select":
    case "scroll":
    case "wait":
      return { allowed: true, scrub: false };
  }
}

/**
 * Remove filled secret values from text destined for the model. Defense in
 * depth behind the blocked read paths: even if a value reaches page text, it is
 * replaced before the model can see it.
 */
export function scrubSecrets(text: string, secretValues: readonly string[]): string {
  let output = text;
  for (const value of secretValues) {
    if (value.length < 4) continue; // too short to redact safely
    output = output.split(value).join("[redacted]");
  }
  return output;
}
