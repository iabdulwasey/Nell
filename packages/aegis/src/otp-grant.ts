/**
 * Scoped one-time-code reads.
 *
 * The fallback for when a site texts or emails a code and there is no TOTP seed
 * in the vault. It is the capability that phished a shipped personal agent, and
 * the difference between their version and this one is the whole design:
 *
 *   theirs: the agent has standing access to the inbox and reads whatever it
 *           judges relevant, which makes the inbox a channel an attacker can
 *           write instructions into.
 *
 *   ours:   the agent cannot read the inbox at all. When it hits a 2FA wall it
 *           asks the user to approve reading the login code *for that one site*.
 *           On yes, a grant is minted that permits exactly one scoped read, and
 *           what comes back is a string of digits.
 *
 * The property that makes this safe is not the approval — it is what the
 * approval buys. A grant does not unlock the inbox; it unlocks a function whose
 * entire output is four to eight digits. **A six-digit code cannot carry a
 * prompt injection.** There is no room in it for an instruction, which is why
 * scoped extraction is safe where free-text access is not, and why the
 * narrowness of the return type is load-bearing rather than tidy.
 *
 * Everything else here is ordinary credential hygiene: single-use, minutes-long,
 * bound to the origin that asked and to the workspace that approved.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeOrigin } from "./origin.js";

export interface OtpGrant {
  readonly id: string;
  readonly workspaceId: string;
  /** The site the agent was on when it hit the wall. */
  readonly origin: string;
  readonly taskId: string;
  readonly tokenHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly usedAt?: number;
  /**
   * Messages older than this are not eligible. A code from last week is not the
   * code this login is waiting for, and reading it would mean the window is
   * wider than the user thinks it is.
   */
  readonly notBefore: number;
}

/**
 * Ten minutes to use the grant. A login flow that has not reached the code entry
 * box within ten minutes has gone wrong and should be restarted rather than
 * carried on with standing permission.
 */
export const OTP_GRANT_TTL_MS = 10 * 60 * 1000;

/**
 * How far back a message may be. Deliberately shorter than the grant: the code
 * arrives after the agent triggers the send, so anything older than five minutes
 * predates the request and belongs to something else.
 */
export const OTP_MESSAGE_WINDOW_MS = 5 * 60 * 1000;

export interface MintOtpGrantOptions {
  readonly workspaceId: string;
  readonly origin: string;
  readonly taskId: string;
  readonly pepper: string;
  readonly now: number;
  readonly ttlMs?: number;
  readonly id?: string;
}

export interface MintedOtpGrant {
  readonly grant: OtpGrant;
  readonly token: string;
}

export function hashOtpToken(token: string, pepper: string): string {
  return createHmac("sha256", pepper).update(token).digest("hex");
}

export function mintOtpGrant(options: MintOtpGrantOptions): MintedOtpGrant {
  const token = randomBytes(32).toString("base64url");
  const normalized = normalizeOrigin(options.origin);
  if (!normalized) throw new Error("Cannot scope a code read to a malformed origin.");

  return {
    token,
    grant: {
      id: options.id ?? randomBytes(8).toString("hex"),
      workspaceId: options.workspaceId,
      origin: normalized,
      taskId: options.taskId,
      tokenHash: hashOtpToken(token, options.pepper),
      issuedAt: options.now,
      expiresAt: options.now + (options.ttlMs ?? OTP_GRANT_TTL_MS),
      notBefore: options.now - OTP_MESSAGE_WINDOW_MS,
    },
  };
}

export type OtpDenialReason =
  | "no-grant"
  | "unknown-token"
  | "expired"
  | "already-used"
  | "wrong-workspace"
  | "wrong-origin"
  | "message-too-old"
  | "sender-mismatch"
  | "no-code-found";

export type OtpDecision =
  | { readonly ok: true; readonly code: string; readonly grant: OtpGrant }
  | { readonly ok: false; readonly reason: OtpDenialReason };

export interface CandidateMessage {
  /** Sender address or number, as the provider reported it. */
  readonly from: string;
  readonly receivedAt: number;
  /** The code already lifted out by the quarantined extractor. */
  readonly code?: string;
  /** Sender domain, likewise extracted rather than parsed here. */
  readonly senderDomain?: string;
}

export interface RedeemOtpOptions {
  readonly token: string;
  readonly workspaceId: string;
  /** The origin the browser is ACTUALLY on, read from the live session. */
  readonly origin: string;
  readonly pepper: string;
  readonly now: number;
  readonly messages: readonly CandidateMessage[];
}

/**
 * Redeem a grant for one code.
 *
 * Note the shape of the return: a string of digits or a refusal. There is no
 * variant that carries a subject line, a sender, or a body — not because those
 * would be dangerous to show a user, but because a function that *can* return
 * prose is a function someone will eventually use to return prose.
 */
export function redeemOtpGrant(
  candidates: readonly OtpGrant[],
  options: RedeemOtpOptions
): OtpDecision {
  if (candidates.length === 0) return { ok: false, reason: "no-grant" };

  const presented = hashOtpToken(options.token, options.pepper);
  const grant = candidates.find((candidate) => constantTimeEquals(candidate.tokenHash, presented));

  if (!grant) return { ok: false, reason: "unknown-token" };
  if (grant.usedAt !== undefined) return { ok: false, reason: "already-used" };
  if (options.now >= grant.expiresAt) return { ok: false, reason: "expired" };
  if (grant.workspaceId !== options.workspaceId) {
    return { ok: false, reason: "wrong-workspace" };
  }

  // The live origin, not one the model asserted. A grant approved for a bank is
  // not a grant to read a code while sitting on an attacker's page.
  const actual = normalizeOrigin(options.origin);
  if (!actual || actual !== grant.origin) return { ok: false, reason: "wrong-origin" };

  const recent = options.messages.filter((message) => message.receivedAt >= grant.notBefore);
  if (recent.length === 0 && options.messages.length > 0) {
    return { ok: false, reason: "message-too-old" };
  }

  // The sender should plausibly belong to the site being logged into. Not proof
  // — a determined attacker can register a lookalike domain — but it stops the
  // ordinary case of an unrelated code being handed over because it happened to
  // be the newest thing in the inbox.
  const host = hostOf(grant.origin);
  const plausible = recent.filter((message) => senderMatches(message, host));
  if (plausible.length === 0 && recent.length > 0) {
    return { ok: false, reason: "sender-mismatch" };
  }

  // Newest first: a re-sent code supersedes the one before it.
  const newest = [...plausible].sort((a, b) => b.receivedAt - a.receivedAt)[0];
  const code = newest?.code;
  if (!code || !/^\d{4,8}$/u.test(code)) return { ok: false, reason: "no-code-found" };

  return { ok: true, code, grant };
}

export function markOtpUsed(grant: OtpGrant, now: number): OtpGrant {
  return { ...grant, usedAt: now };
}

/**
 * What the user is asked.
 *
 * Names the site, says exactly what will be read, and says what will not be.
 * A prompt that says only "allow access to your email?" is asking for something
 * far larger than what is actually needed, and teaching someone to say yes to
 * that is its own harm.
 */
export function otpApprovalPrompt(origin: string): string {
  return (
    `${hostOf(origin)} wants a login code. May I read just the code from your ` +
    `messages for this one sign-in? I will not read anything else, and this ` +
    `permission ends as soon as I use it.`
  );
}

export function explainOtpDenial(reason: OtpDenialReason): string {
  switch (reason) {
    case "no-grant":
      return "I do not have permission to read a login code right now.";
    case "unknown-token":
    case "wrong-workspace":
      return "That permission is not valid.";
    case "expired":
      return "That permission has expired — I can ask again.";
    case "already-used":
      return "I have already used that permission. I can ask again if the code did not work.";
    case "wrong-origin":
      return "The browser is not on the site that permission was granted for.";
    case "message-too-old":
      return "The only codes I can see are older than this sign-in, so they are not the right one.";
    case "sender-mismatch":
      return "I could not find a code from that site.";
    case "no-code-found":
      return "No code has arrived yet.";
  }
}

function senderMatches(message: CandidateMessage, host: string): boolean {
  const domain = (message.senderDomain ?? message.from).toLowerCase();
  const registrable = host.split(".").slice(-2).join(".");
  // Codes are routinely sent from a shared or shortcode sender, which carries no
  // domain at all. A numeric sender is accepted because refusing it would break
  // SMS 2FA entirely, which is most of the cases this exists for.
  if (/^\+?\d[\d\s-]*$/u.test(domain)) return true;
  return domain.includes(registrable);
}

function hostOf(origin: string): string {
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
