/**
 * Live-view handoff.
 *
 * Some walls are not the agent's to climb. A CAPTCHA is *designed* to refuse
 * automation, a 3-D Secure step deliberately routes to the cardholder, and a
 * code texted to the user's own phone is not on the machine at all. An agent
 * that treats these as puzzles either fails slowly or gets the account flagged
 * for trying. The honest move is to hand the controls to the person for thirty
 * seconds and carry on afterwards.
 *
 * This is also the answer to the failure mode the persistent-machine
 * architecture is most exposed to. It is the same trick Instinct's desktop app
 * uses — put a human in the loop at exactly the moment a human is required.
 *
 * **A handoff link is a session takeover link.** Whoever opens it is driving a
 * browser that is signed into the user's accounts. So it is treated like a
 * credential and not like a URL:
 *
 * - the token is 32 random bytes, stored only as a peppered hash, compared in
 *   constant time, and never written to a log or an audit detail;
 * - it expires in minutes, because the window only needs to cover "the user
 *   picks up their phone";
 * - it is single-use — redeeming consumes it, so a link resent, forwarded, or
 *   left in a message history is inert;
 * - it is bound to one workspace, one machine, and one stated reason, so a
 *   token minted to clear a CAPTCHA cannot be redeemed against a different
 *   machine or repurposed into general access;
 * - it can be revoked, and is revoked when the task that requested it ends.
 *
 * While the human is driving, the agent is not. Two parties on one pointer
 * would fight, and worse, the agent could act inside a state the user
 * authenticated and the policy engine never saw.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Why control is being handed over.
 *
 * Stated up front and bound into the grant, so the user is told what they are
 * being asked to do before they open a link into their own signed-in browser —
 * and so a grant cannot be minted for a small reason and used for a large one.
 */
export const handoffReasonSchema = z.enum([
  "captcha",
  /** A code the user must read from their own phone or authenticator. */
  "two-factor",
  /** 3-D Secure or a bank's own approval step. */
  "payment-authentication",
  /** A login the agent has no stored credential for. */
  "login",
  /** The page is in a state the worker cannot make sense of. */
  "unexpected-state",
  "user-requested",
]);

export type HandoffReason = z.infer<typeof handoffReasonSchema>;

export function describeReason(reason: HandoffReason): string {
  switch (reason) {
    case "captcha":
      return "clear a CAPTCHA";
    case "two-factor":
      return "enter a code from your phone";
    case "payment-authentication":
      return "approve the payment with your bank";
    case "login":
      return "sign in";
    case "unexpected-state":
      return "take a look — the page is not what I expected";
    case "user-requested":
      return "take over";
  }
}

export interface HandoffGrant {
  readonly id: string;
  readonly workspaceId: string;
  readonly machineId: string;
  /** Task paused pending this handoff, so completion can resume it. */
  readonly taskId: string;
  readonly reason: HandoffReason;
  /** Peppered hash of the token. The token itself is never stored. */
  readonly tokenHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly redeemedAt?: number;
  readonly revokedAt?: number;
  /** Origin the machine was on when help was requested. */
  readonly origin: string;
}

/**
 * Five minutes: long enough for someone to notice a message and pick up their
 * phone, short enough that a link left in a chat log is dead by the time anyone
 * scrolls back to it.
 */
export const DEFAULT_HANDOFF_TTL_MS = 5 * 60 * 1000;

export interface MintHandoffOptions {
  readonly workspaceId: string;
  readonly machineId: string;
  readonly taskId: string;
  readonly reason: HandoffReason;
  readonly origin: string;
  readonly pepper: string;
  readonly now: number;
  readonly ttlMs?: number;
  readonly id?: string;
}

export interface MintedHandoff {
  readonly grant: HandoffGrant;
  /**
   * The secret. Returned exactly once, to be put in the link and then forgotten
   * — it cannot be recovered from the grant.
   */
  readonly token: string;
}

export function hashToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

export function mintHandoff(options: MintHandoffOptions): MintedHandoff {
  // 32 bytes. This is guarded by nothing but its own unguessability: a live-view
  // URL is necessarily reachable by whoever holds it.
  const token = randomBytes(32).toString("base64url");
  const ttl = options.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;

  return {
    token,
    grant: {
      id: options.id ?? randomBytes(8).toString("hex"),
      workspaceId: options.workspaceId,
      machineId: options.machineId,
      taskId: options.taskId,
      reason: options.reason,
      tokenHash: hashToken(token, options.pepper),
      issuedAt: options.now,
      expiresAt: options.now + ttl,
      origin: options.origin,
    },
  };
}

export type HandoffDenialReason =
  | "unknown-token"
  | "expired"
  | "already-used"
  | "revoked"
  | "wrong-workspace"
  | "wrong-machine";

export type HandoffDecision =
  | { readonly ok: true; readonly grant: HandoffGrant }
  | { readonly ok: false; readonly reason: HandoffDenialReason };

export interface RedeemOptions {
  readonly token: string;
  readonly workspaceId: string;
  readonly machineId: string;
  readonly pepper: string;
  readonly now: number;
}

/**
 * Redeem a handoff, returning the grant it unlocks.
 *
 * Candidate grants are supplied by the caller (a query keyed on workspace), and
 * matched here by constant-time comparison of the hash. Looking the grant up by
 * token would mean the lookup itself leaked whether a token exists, through
 * timing and through the shape of the query.
 */
export function redeemHandoff(
  candidates: readonly HandoffGrant[],
  options: RedeemOptions
): HandoffDecision {
  const presented = hashToken(options.token, options.pepper);
  const grant = candidates.find((candidate) => constantTimeEquals(candidate.tokenHash, presented));

  if (!grant) return { ok: false, reason: "unknown-token" };
  if (grant.revokedAt !== undefined) return { ok: false, reason: "revoked" };
  if (grant.redeemedAt !== undefined) return { ok: false, reason: "already-used" };
  if (options.now >= grant.expiresAt) return { ok: false, reason: "expired" };

  // Checked even though the candidate list is workspace-scoped: defence that
  // depends on the caller having filtered correctly is defence that ends the
  // first time someone writes a new caller.
  if (grant.workspaceId !== options.workspaceId) {
    return { ok: false, reason: "wrong-workspace" };
  }
  if (grant.machineId !== options.machineId) {
    return { ok: false, reason: "wrong-machine" };
  }

  return { ok: true, grant };
}

/** Consume a grant. Redeeming is what makes the link single-use. */
export function markRedeemed(grant: HandoffGrant, now: number): HandoffGrant {
  return { ...grant, redeemedAt: now };
}

/**
 * Revoke a grant. Called when the task ends, when the user says they are done,
 * and whenever a task is cancelled — an outstanding link to a signed-in browser
 * should not outlive the reason it was created.
 */
export function revokeHandoff(grant: HandoffGrant, now: number): HandoffGrant {
  return grant.revokedAt === undefined ? { ...grant, revokedAt: now } : grant;
}

export function explainHandoffDenial(reason: HandoffDenialReason): string {
  switch (reason) {
    case "unknown-token":
      return "That link is not valid.";
    case "expired":
      return "That link has expired — ask me to send a new one.";
    case "already-used":
      return "That link has already been used — ask me to send a new one.";
    case "revoked":
      return "That link was cancelled.";
    case "wrong-workspace":
      return "That link is not valid.";
    case "wrong-machine":
      return "That link is not valid for this machine.";
  }
}

/**
 * What the user is sent.
 *
 * Deliberately says what the agent was doing and why it stopped. "Tap here"
 * with no context trains people to open unexplained links into their own
 * signed-in accounts, which is the exact habit that makes phishing work.
 */
export function handoffMessage(grant: HandoffGrant, url: string): string {
  const site = siteOf(grant.origin);
  return `I need you to ${describeReason(grant.reason)} on ${site}. Tap to take over — I'll pick up where you leave off: ${url}`;
}

function siteOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Control state of a machine.
 *
 * `human` means a redeemed handoff is open. The executor refuses agent actions
 * in that state: the agent must not be clicking while the person is, and must
 * not act inside a state the person authenticated that policy never saw.
 */
export type ControlHolder = "agent" | "human";

export interface ControlState {
  readonly holder: ControlHolder;
  readonly grantId?: string;
  readonly since?: number;
}

export const AGENT_IN_CONTROL: ControlState = { holder: "agent" };

export function handOverControl(grant: HandoffGrant, now: number): ControlState {
  return { holder: "human", grantId: grant.id, since: now };
}

export function takeBackControl(): ControlState {
  return AGENT_IN_CONTROL;
}
