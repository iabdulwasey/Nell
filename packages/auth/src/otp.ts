/**
 * One-time passcode issuance and verification.
 *
 * Phone-number sign-in is the front door to an account that holds credentials
 * and a payment method, so the details here matter more than they look:
 *
 * - codes are generated with a CSPRNG, never Math.random
 * - only a hash of the code is stored, so a database leak does not hand over
 *   live codes
 * - comparison is constant-time, so timing cannot be used to guess a code
 * - attempts are capped and the challenge is consumed on success, so a code
 *   cannot be brute-forced or replayed
 *
 * Delivery is a separate port. This module never talks to a provider, which is
 * what makes the whole flow testable without an SMS account.
 */

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const CODE_LENGTH = 6;
export const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 5;

/** A pending challenge. Persisted by the caller; contains no live code. */
export interface OtpChallenge {
  readonly id: string;
  /** Normalized E.164 destination. */
  readonly destination: string;
  /** HMAC of the code — never the code itself. */
  readonly codeHash: string;
  readonly expiresAt: number;
  readonly attempts: number;
  readonly consumedAt?: number;
}

export interface IssuedOtp {
  readonly challenge: OtpChallenge;
  /**
   * The plaintext code, returned exactly once so the caller can hand it to a
   * delivery provider. It is never stored.
   */
  readonly code: string;
}

/** Uniformly distributed numeric code. randomInt avoids modulo bias. */
export function generateCode(length: number = CODE_LENGTH): string {
  let code = "";
  for (let i = 0; i < length; i += 1) code += String(randomInt(0, 10));
  return code;
}

/**
 * Hash a code for storage. Keyed with a server-side pepper so that stolen rows
 * cannot be attacked offline without also stealing the pepper.
 */
export function hashCode(code: string, challengeId: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`${challengeId}:${code}`).digest("hex");
}

export interface IssueOptions {
  readonly id: string;
  readonly destination: string;
  readonly pepper: string;
  readonly now: number;
  readonly ttlMs?: number;
}

export function issueOtp(options: IssueOptions): IssuedOtp {
  const code = generateCode();
  return {
    code,
    challenge: {
      id: options.id,
      destination: options.destination,
      codeHash: hashCode(code, options.id, options.pepper),
      expiresAt: options.now + (options.ttlMs ?? DEFAULT_TTL_MS),
      attempts: 0,
    },
  };
}

export type OtpFailure = "expired" | "already-used" | "too-many-attempts" | "incorrect";

export type OtpResult =
  | { readonly ok: true; readonly challenge: OtpChallenge }
  | { readonly ok: false; readonly reason: OtpFailure; readonly challenge: OtpChallenge };

export interface VerifyOptions {
  readonly challenge: OtpChallenge;
  readonly code: string;
  readonly pepper: string;
  readonly now: number;
}

/**
 * Verify a submitted code. Returns the updated challenge in every case so the
 * caller can persist the attempt count — a failed attempt must cost something,
 * or the cap is meaningless.
 */
export function verifyOtp(options: VerifyOptions): OtpResult {
  const { challenge, code, pepper, now } = options;

  if (challenge.consumedAt !== undefined) {
    return { ok: false, reason: "already-used", challenge };
  }
  if (challenge.expiresAt <= now) {
    return { ok: false, reason: "expired", challenge };
  }
  if (challenge.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "too-many-attempts", challenge };
  }

  const attempted: OtpChallenge = { ...challenge, attempts: challenge.attempts + 1 };
  const expected = hashCode(code, challenge.id, pepper);

  if (!constantTimeEquals(expected, challenge.codeHash)) {
    return { ok: false, reason: "incorrect", challenge: attempted };
  }

  // Consume on success so the same code cannot be replayed.
  return { ok: true, challenge: { ...attempted, consumedAt: now } };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Messages safe to show a user: never reveal which part was wrong. */
export function explainOtpFailure(reason: OtpFailure): string {
  switch (reason) {
    case "expired":
      return "That code has expired. Request a new one.";
    case "already-used":
      return "That code was already used. Request a new one.";
    case "too-many-attempts":
      return "Too many incorrect attempts. Request a new code.";
    case "incorrect":
      return "That code is not correct.";
  }
}
