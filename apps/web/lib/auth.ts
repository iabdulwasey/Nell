/**
 * Signing in to the dashboard.
 *
 * The dashboard has been an open window: it shows whatever belongs to the owner
 * and never asks who is looking. On a laptop that is survivable; on anything
 * reachable it is one person's tasks, memory and vault labels served to whoever
 * asks. `@nell/auth` has had the OTP machinery since Phase 0 — peppered hashes,
 * constant-time compare, attempt caps, single use, rate limits — with delivery
 * left as a port and no caller.
 *
 * **The code arrives on Telegram, which is the neat part.** The obvious reading
 * of "phone OTP" is an SMS provider, an account and a bill. But the owner of
 * this Nell is *defined* as a Telegram id — it is what decides who may text the
 * bot — so proving you control that account is exactly the right proof for this
 * dashboard, and it needs no vendor at all. The delivery port did not care what
 * was on the other side of it, which is what a port is for.
 *
 * Two things are never stored: the code (only a peppered hash) and the session
 * token (only its hash). Reading either table tells an attacker that somebody
 * signed in, and nothing more.
 */

import {
  explainOtpFailure,
  hashCode,
  issueOtp,
  renderOtpMessage,
  verifyOtp,
  type OtpChallenge,
} from "@nell/auth";
import { createPool } from "@nell/db";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

/** How long a signed-in session lasts before it must be re-established. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "nell_session";

const holder = globalThis as unknown as { __nellAuthPool?: Pool };

function pool(): Pool | undefined {
  const url = process.env["DATABASE_URL"];
  if (!url) return undefined;
  holder.__nellAuthPool ??= createPool(url);
  return holder.__nellAuthPool;
}

/**
 * The pepper, which is what makes a stolen table useless.
 *
 * Reused from the vault key rather than adding a second secret to configure:
 * both are "a secret this deployment holds", and asking an operator to generate
 * two is how one of them ends up as `changeme`. Absent, sign-in refuses rather
 * than falling back to an unpeppered hash — a weaker mode nobody chose is worse
 * than a loud refusal.
 */
function pepper(): string | undefined {
  return process.env["SECRET_ENCRYPTION_KEY"];
}

/** Who may sign in. One person, the same one who may text the bot. */
function owner(): string | undefined {
  return process.env["NELL_OWNER_TELEGRAM_ID"];
}

export function authAvailable(): boolean {
  return Boolean(pool() && pepper() && owner() && process.env["TELEGRAM_BOT_TOKEN"]);
}

/**
 * Send a code to the owner's Telegram.
 *
 * One Bot API call rather than `TelegramChannel`, which is built for webhook
 * ingress and rich outbound and refuses to construct without a webhook secret —
 * this deployment long-polls and has none. A verification code needs no
 * formatting, no splitting and no thread.
 */
async function deliver(code: string): Promise<void> {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = owner();
  if (!token || !chatId) throw new Error("Telegram is not configured.");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: renderOtpMessage(code) }),
  });

  if (!response.ok) throw new Error("Could not send the code.");
}

export type RequestOutcome =
  | { readonly ok: true; readonly challengeId: string }
  | { readonly ok: false; readonly reason: string };

export async function requestCode(): Promise<RequestOutcome> {
  const db = pool();
  const secret = pepper();
  const destination = owner();
  if (!db || !secret || !destination) {
    return { ok: false, reason: "Sign-in is not configured on this install." };
  }

  /**
   * One live challenge at a time.
   *
   * Without this, asking for a code repeatedly leaves a pile of valid codes,
   * and each one is a separate guess target with its own attempt budget — so
   * the attempt cap, which is the thing standing between six digits and a
   * brute force, would be defeated by pressing the button.
   */
  await db.query(
    `UPDATE auth_challenges SET consumed_at = now()
      WHERE destination = $1 AND consumed_at IS NULL`,
    [destination]
  );

  const issued = issueOtp({ id: randomUUID(), destination, pepper: secret, now: Date.now() });

  await db.query(
    `INSERT INTO auth_challenges (id, destination, code_hash, expires_at, attempts)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), 0)`,
    [
      issued.challenge.id,
      issued.challenge.destination,
      issued.challenge.codeHash,
      issued.challenge.expiresAt,
    ]
  );

  try {
    await deliver(issued.code);
  } catch {
    return { ok: false, reason: "I couldn't send the code to Telegram." };
  }

  return { ok: true, challengeId: issued.challenge.id };
}

export type VerifyOutcome =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: string };

export async function verifyCode(challengeId: string, code: string): Promise<VerifyOutcome> {
  const db = pool();
  const secret = pepper();
  const who = owner();
  if (!db || !secret || !who) return { ok: false, reason: "Sign-in is not configured." };

  const { rows } = await db.query<{
    id: string;
    destination: string;
    code_hash: string;
    expires_at: Date;
    attempts: number;
    consumed_at: Date | null;
  }>(
    `SELECT id, destination, code_hash, expires_at, attempts, consumed_at
       FROM auth_challenges WHERE id = $1`,
    [challengeId]
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: "That code has expired. Ask for a new one." };

  const challenge: OtpChallenge = {
    id: row.id,
    destination: row.destination,
    codeHash: row.code_hash,
    expiresAt: row.expires_at.getTime(),
    attempts: row.attempts,
    ...(row.consumed_at ? { consumedAt: row.consumed_at.getTime() } : {}),
  };

  const result = verifyOtp({ challenge, code, pepper: secret, now: Date.now() });

  /**
   * The attempt is recorded whichever way it went.
   *
   * A wrong guess that does not increment is an unlimited guess, and six digits
   * fall in under a second to something that can try forever. Written before the
   * outcome is returned so a caller that stops reading cannot skip it.
   */
  await db.query(`UPDATE auth_challenges SET attempts = $2, consumed_at = $3 WHERE id = $1`, [
    row.id,
    result.challenge.attempts,
    result.challenge.consumedAt ? new Date(result.challenge.consumedAt) : null,
  ]);

  if (!result.ok) return { ok: false, reason: explainOtpFailure(result.reason) };

  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
    [hashToken(token, secret), `tg-${who}`, Date.now() + SESSION_TTL_MS]
  );

  return { ok: true, token };
}

/** Who this cookie belongs to, or nobody. */
export async function sessionUser(token: string | undefined): Promise<string | undefined> {
  const db = pool();
  const secret = pepper();
  if (!db || !secret || !token) return undefined;

  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM auth_sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(token, secret)]
  );
  return rows[0]?.user_id;
}

export async function signOut(token: string | undefined): Promise<void> {
  const db = pool();
  const secret = pepper();
  if (!db || !secret || !token) return;

  // Revoked rather than deleted, so "when did that session end" stays
  // answerable — the same reason a directive is revoked rather than removed.
  await db.query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token, secret)]
  );
}

/**
 * The stored form of a session token.
 *
 * Peppered like the codes, so a leaked table cannot be turned into a working
 * cookie even by someone who can compute SHA-256.
 */
function hashToken(token: string, secret: string): string {
  return createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

export { hashCode };
