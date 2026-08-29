/**
 * Time-based one-time passwords (RFC 6238).
 *
 * The best answer to a 2FA wall, and the one worth reaching for first: with the
 * TOTP seed in the vault, Nell computes the code itself. No inbox is opened, no
 * message is read, no approval is needed for a read that never happens. The
 * capability that got a shipped agent phished is simply not exercised.
 *
 * That is the shape of the whole design here. Instinct's agent reads codes out
 * of the connected inbox, which means the inbox is a channel an attacker can
 * write into — and one did. Generating the code locally removes the channel
 * instead of guarding it.
 *
 * The seed is a credential of the highest order: it is the second factor, and
 * anyone holding it can mint codes forever. It lives in the vault under the same
 * envelope encryption as a password, is never rendered, and is never handed to a
 * model — the model asks for "the current code for this item" and receives six
 * digits, which is not a secret a minute from now.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** RFC 6238 defaults, and what essentially every site uses. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpConfig {
  /** Base32 seed, as printed in a QR code. */
  readonly secret: string;
  readonly digits?: number;
  readonly periodSeconds?: number;
  readonly algorithm?: TotpAlgorithm;
}

/**
 * Decode RFC 4648 base32.
 *
 * Written out rather than pulled from a dependency: this runs on the second
 * factor, and a supply-chain compromise in a five-line decoder would be a very
 * quiet way to lose every user's 2FA seed.
 */
export function decodeBase32(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = input.toUpperCase().replaceAll(/[\s-]/gu, "").replaceAll("=", "");

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index === -1) throw new Error("Not a valid base32 secret.");

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * The code for a given moment.
 *
 * `atMs` is passed in rather than read from the clock so this is testable
 * against the RFC's published vectors — a TOTP implementation that has not been
 * checked against those is a coin flip, and the failure mode is "login works
 * sometimes", which nobody debugs correctly.
 */
export function totpAt(config: TotpConfig, atMs: number): string {
  const digits = config.digits ?? TOTP_DIGITS;
  const period = config.periodSeconds ?? TOTP_PERIOD_SECONDS;
  const algorithm = (config.algorithm ?? "SHA1").toLowerCase();

  const counter = Math.floor(atMs / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, decodeBase32(config.secret)).update(buffer).digest();

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** How much clock drift to tolerate when checking a code, in steps either way. */
export const DRIFT_STEPS = 1;

/**
 * Whether a code is currently valid.
 *
 * Accepts one step either side, because a phone's clock and a server's clock
 * disagree often enough that zero tolerance means real users failing to log in.
 * Compared in constant time — a six-digit code has only a million possibilities,
 * and a timing oracle narrows that far too quickly.
 */
export function verifyTotp(config: TotpConfig, code: string, atMs: number): boolean {
  const period = (config.periodSeconds ?? TOTP_PERIOD_SECONDS) * 1000;
  let matched = false;

  for (let step = -DRIFT_STEPS; step <= DRIFT_STEPS; step += 1) {
    const candidate = totpAt(config, atMs + step * period);
    // No early return: leaving the loop on the first match would leak which
    // step matched through timing.
    if (constantTimeEquals(candidate, code)) matched = true;
  }

  return matched;
}

/** Seconds until the current code expires, for telling a user whether to hurry. */
export function secondsRemaining(config: TotpConfig, atMs: number): number {
  const period = config.periodSeconds ?? TOTP_PERIOD_SECONDS;
  return period - (Math.floor(atMs / 1000) % period);
}

/**
 * Parse an `otpauth://` URI, which is what a QR code actually contains.
 *
 * Users copy these from a setup page, and asking someone to pick the base32 seed
 * out of a URL by hand is how a seed ends up mistyped and a login mysteriously
 * stops working two weeks later.
 */
export function parseOtpauthUri(uri: string): TotpConfig | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "otpauth:") return undefined;
  // HOTP is counter-based and a different thing entirely; accepting one here
  // would produce codes that are always wrong.
  if (parsed.hostname.toLowerCase() !== "totp") return undefined;

  const secret = parsed.searchParams.get("secret");
  if (!secret) return undefined;

  try {
    decodeBase32(secret);
  } catch {
    return undefined;
  }

  const digits = Number(parsed.searchParams.get("digits") ?? TOTP_DIGITS);
  const period = Number(parsed.searchParams.get("period") ?? TOTP_PERIOD_SECONDS);
  const algorithm = (parsed.searchParams.get("algorithm") ?? "SHA1").toUpperCase();

  if (!["SHA1", "SHA256", "SHA512"].includes(algorithm)) return undefined;
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) return undefined;
  if (!Number.isInteger(period) || period < 10 || period > 300) return undefined;

  return { secret, digits, periodSeconds: period, algorithm: algorithm as TotpAlgorithm };
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
