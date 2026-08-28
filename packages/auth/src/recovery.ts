/**
 * Recovery codes.
 *
 * A phone number is not a durable credential — SIM swaps happen, numbers get
 * reassigned, people move country. Without a recovery path, losing a number
 * means losing a vault full of credentials permanently.
 *
 * Codes are single-use, stored only as hashes, and compared in constant time.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;

/** Unambiguous alphabet: no 0/O, 1/I/L, so a transcribed code still works. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GROUP = 5;
const GROUPS = 2;

export interface RecoveryCodeRecord {
  readonly hash: string;
  readonly usedAt?: number;
}

export interface GeneratedRecoveryCodes {
  /** Shown to the user exactly once, at generation. */
  readonly codes: readonly string[];
  /** Persisted. Contains no recoverable code. */
  readonly records: readonly RecoveryCodeRecord[];
}

function randomCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = "";
    // rejection-free: index into the alphabet from a uniform byte range
    const bytes = randomBytes(GROUP * 2);
    let taken = 0;
    for (let i = 0; taken < GROUP && i < bytes.length; i += 1) {
      const byte = bytes[i] ?? 0;
      // Discard values that would bias the distribution.
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      group += ALPHABET[byte % ALPHABET.length];
      taken += 1;
    }
    groups.push(group);
  }
  return groups.join("-");
}

export function hashRecoveryCode(code: string, pepper: string): string {
  // Normalize so formatting and case do not affect matching.
  const normalized = code.replaceAll(/[^A-Za-z0-9]/gu, "").toUpperCase();
  return createHmac("sha256", pepper).update(normalized).digest("hex");
}

export function generateRecoveryCodes(
  pepper: string,
  count: number = RECOVERY_CODE_COUNT
): GeneratedRecoveryCodes {
  const codes = Array.from({ length: count }, () => randomCode());
  return {
    codes,
    records: codes.map((code) => ({ hash: hashRecoveryCode(code, pepper) })),
  };
}

export type RecoveryResult =
  | {
      readonly ok: true;
      readonly records: readonly RecoveryCodeRecord[];
      readonly remaining: number;
    }
  | { readonly ok: false; readonly reason: "invalid" | "already-used" };

/**
 * Redeem a code. On success the matching record is marked used and returned, so
 * a code cannot be replayed.
 */
export function redeemRecoveryCode(
  records: readonly RecoveryCodeRecord[],
  code: string,
  pepper: string,
  now: number
): RecoveryResult {
  const candidate = hashRecoveryCode(code, pepper);

  let matchedIndex = -1;
  // Scan every record so timing does not reveal the matching position.
  for (const [index, record] of records.entries()) {
    if (constantTimeEquals(record.hash, candidate)) matchedIndex = index;
  }

  if (matchedIndex === -1) return { ok: false, reason: "invalid" };
  if (records[matchedIndex]?.usedAt !== undefined) {
    return { ok: false, reason: "already-used" };
  }

  const updated = records.map((record, index) =>
    index === matchedIndex ? { ...record, usedAt: now } : record
  );
  return {
    ok: true,
    records: updated,
    remaining: updated.filter((record) => record.usedAt === undefined).length,
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
