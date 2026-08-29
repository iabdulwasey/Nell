/**
 * What the companion will and will not do.
 *
 * This is the file that makes the desktop companion defensible, and the argument
 * behind it is the one thing worth understanding about the whole feature.
 *
 * Everywhere else in Nell, the server owns the machine and enforces policy
 * centrally: the executor is the chokepoint, and a worker cannot get round it.
 * That model does not transfer to a laptop. On someone's own computer **we are
 * the outside party**, and a companion that faithfully executes whatever the
 * server sends has handed control of every paired machine to whoever controls
 * our infrastructure. That is not a risk to manage with good operational
 * practice; it is a design that should not ship.
 *
 * So the companion evaluates rather than obeys. It holds its own allowlist,
 * enforces its own limits, and refuses on its own authority. A command from the
 * server is a *request*, treated with roughly the suspicion the agent applies to
 * an email. If our servers were fully compromised tomorrow, the worst that could
 * be done to a paired laptop is what that laptop had already agreed to — which
 * is a bounded, inspectable, user-chosen set, and small.
 *
 * Two consequences fall out of that and are worth stating plainly:
 *
 * - **The allowlist lives on the device.** A server-held allowlist is a server
 *   that can widen it. The user grants origins in the companion's own UI.
 * - **The user can always see and always stop.** A remote-control session with
 *   no local indicator is indistinguishable from malware, and should be treated
 *   as such by anyone who finds one.
 */

import { z } from "zod";

/**
 * What the companion is willing to be asked to do.
 *
 * Narrower than the cloud machine's vocabulary on purpose. Reading the clipboard
 * or attaching arbitrary files from a personal laptop is a different proposition
 * from doing it in a container we own, and neither is offered here at all.
 */
export const companionActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.url() }),
  z.object({
    action: z.literal("click"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.object({ action: z.literal("type"), text: z.string().max(2000) }),
  z.object({ action: z.literal("scroll"), amount: z.number().int().min(-5000).max(5000) }),
  z.object({ action: z.literal("screenshot") }),
  /** Reads the page's own text. Not the filesystem, not other windows. */
  z.object({ action: z.literal("read-page") }),
]);

export type CompanionAction = z.infer<typeof companionActionSchema>;

export interface LocalPolicy {
  /** Origins the user granted, in the companion's own settings. */
  readonly allowedOrigins: readonly string[];
  /**
   * Whether the user is watching. Sessions are only permitted while the
   * companion window is open and showing what is happening.
   */
  readonly userPresent: boolean;
  /** Set when the user hit stop. Nothing runs again until they say so. */
  readonly halted: boolean;
  /** Longest a single session may run without the user re-confirming. */
  readonly sessionLimitMs: number;
  readonly sessionStartedAt?: number;
}

export const DEFAULT_SESSION_LIMIT_MS = 10 * 60 * 1000;

export function defaultPolicy(): LocalPolicy {
  return {
    // Nothing, until the user says otherwise. A companion that ships with a
    // useful default allowlist has chosen for them.
    allowedOrigins: [],
    userPresent: false,
    halted: false,
    sessionLimitMs: DEFAULT_SESSION_LIMIT_MS,
  };
}

export type LocalRefusal =
  | "halted"
  | "user-absent"
  | "origin-not-allowed"
  | "session-expired"
  | "unsupported-action"
  | "device-revoked";

export type LocalDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: LocalRefusal; readonly message: string };

export interface EvaluateOptions {
  readonly policy: LocalPolicy;
  /** Origin the local browser is ACTUALLY on, read here, not asserted remotely. */
  readonly currentOrigin: string;
  readonly now: number;
  readonly deviceRevoked?: boolean;
}

/**
 * Decide whether to carry out a request from the server.
 *
 * The order is deliberate: the stop button is checked before anything else,
 * because someone who pressed it is not interested in why their request was
 * otherwise reasonable.
 */
export function evaluate(action: CompanionAction, options: EvaluateOptions): LocalDecision {
  const { policy } = options;

  if (options.deviceRevoked) {
    return {
      ok: false,
      reason: "device-revoked",
      message: "This device has been unpaired.",
    };
  }
  if (policy.halted) {
    return { ok: false, reason: "halted", message: "Stopped. Nothing will run until you resume." };
  }

  // A remote-control session with nobody watching is indistinguishable from
  // malware, and should be.
  if (!policy.userPresent) {
    return {
      ok: false,
      reason: "user-absent",
      message: "Nell only drives this computer while you are here watching.",
    };
  }

  if (
    policy.sessionStartedAt !== undefined &&
    options.now - policy.sessionStartedAt > policy.sessionLimitMs
  ) {
    return {
      ok: false,
      reason: "session-expired",
      message: "This session has run long enough — confirm to keep going.",
    };
  }

  const parsed = companionActionSchema.safeParse(action);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "unsupported-action",
      message: "This computer does not do that.",
    };
  }

  // The origin check applies to where the browser IS for page actions, and to
  // where it is being SENT for a navigation. Checking only one leaves the other
  // as the way round it.
  const target =
    action.action === "navigate" ? originOf(action.url) : originOf(options.currentOrigin);
  if (!target || !policy.allowedOrigins.includes(target)) {
    return {
      ok: false,
      reason: "origin-not-allowed",
      message: `You have not allowed Nell to use ${target ?? "that site"} on this computer.`,
    };
  }

  return { ok: true };
}

/**
 * A hostname that could actually exist.
 *
 * `new URL("https://*")` parses, and its origin is the literal string
 * `https://*`. Storing that is not exploitable — no real page ever has that
 * origin, so the entry simply never matches — but it is worse than useless: a
 * user who types a wildcard expecting it to work gets a companion that refuses
 * everything and never says why, which teaches them the allowlist is broken.
 * Rejecting it means they find out immediately.
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/iu;

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    // IPv6 literals arrive bracketed and are legitimate for a local target.
    const host = url.hostname.startsWith("[") ? url.hostname : url.hostname;
    if (!host.startsWith("[") && !HOSTNAME.test(host)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Grant an origin.
 *
 * Additive and explicit, one at a time. There is no "allow all" and no wildcard,
 * because a wildcard is what a user clicks when they are tired and what an
 * attacker asks for when they are patient.
 */
export function allowOrigin(policy: LocalPolicy, origin: string): LocalPolicy {
  const normalized = originOf(origin);
  if (!normalized || policy.allowedOrigins.includes(normalized)) return policy;
  return { ...policy, allowedOrigins: [...policy.allowedOrigins, normalized] };
}

export function revokeOrigin(policy: LocalPolicy, origin: string): LocalPolicy {
  const normalized = originOf(origin);
  return {
    ...policy,
    allowedOrigins: policy.allowedOrigins.filter((allowed) => allowed !== normalized),
  };
}

/** The stop button. Immediate, and requires a deliberate resume. */
export function halt(policy: LocalPolicy): LocalPolicy {
  return { ...policy, halted: true, sessionStartedAt: undefined };
}

export function resume(policy: LocalPolicy, now: number): LocalPolicy {
  return { ...policy, halted: false, sessionStartedAt: now };
}

export function setPresence(policy: LocalPolicy, present: boolean): LocalPolicy {
  return present ? { ...policy, userPresent: true } : { ...policy, userPresent: false };
}

/**
 * What the companion shows while it is working.
 *
 * Present tense and specific. "Nell is working" tells someone nothing they can
 * act on; naming the site and the action is what lets them notice that it is on
 * a page they did not expect.
 */
export function describeActivity(action: CompanionAction, currentOrigin: string): string {
  const site = originOf(currentOrigin)?.replace(/^https?:\/\//u, "") ?? "a page";

  switch (action.action) {
    case "navigate":
      return `Opening ${originOf(action.url)?.replace(/^https?:\/\//u, "") ?? "a page"}`;
    case "click":
      return `Clicking on ${site}`;
    case "type":
      return `Typing on ${site}`;
    case "scroll":
      return `Scrolling ${site}`;
    case "screenshot":
      return `Looking at ${site}`;
    case "read-page":
      return `Reading ${site}`;
  }
}

export function explainLocalRefusal(reason: LocalRefusal): string {
  switch (reason) {
    case "halted":
      return "You stopped it.";
    case "user-absent":
      return "Nell only uses this computer while you are watching.";
    case "origin-not-allowed":
      return "That site is not on this computer's allowed list.";
    case "session-expired":
      return "The session ran its length and needs confirming again.";
    case "unsupported-action":
      return "This computer does not do that.";
    case "device-revoked":
      return "This device has been unpaired.";
  }
}
