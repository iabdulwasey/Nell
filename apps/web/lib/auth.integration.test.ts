/**
 * Signing in, against a real database.
 *
 * The OTP arithmetic is tested in `@nell/auth` and is not retested here. What is
 * untested until now is the wiring, which is where this kind of thing actually
 * fails: a challenge that is stored but never read back, an attempt counter that
 * increments in memory and not on the row, a session that verifies against a
 * token nobody hashed the same way twice.
 *
 * Delivery is not exercised — it posts to Telegram — so these drive the pieces
 * either side of it.
 */

import { hashCode } from "@nell/auth";
import { createPool } from "@nell/db";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_TTL_MS, sessionUser, signOut, verifyCode } from "./auth.js";

const url = process.env["DATABASE_URL"];
const pepper = process.env["SECRET_ENCRYPTION_KEY"];
/**
 * The same three things `verifyCode` refuses without.
 *
 * The first version checked only the database and the pepper, so under turbo —
 * which passes a narrower environment than a bare `vitest` run — the tests ran
 * with no owner id and failed on `expected false to be true`, which says
 * nothing about what was missing. A precondition weaker than the code's is a
 * suite that fails misleadingly instead of skipping honestly.
 */
const runnable = Boolean(url && pepper && process.env["NELL_OWNER_TELEGRAM_ID"]);
const describeDb = runnable ? describe : describe.skip;

let pool: Pool;

/** A challenge written the way `requestCode` writes one, minus the sending. */
async function plant(code: string, options: { expired?: boolean; attempts?: number } = {}) {
  const id = randomUUID();
  const destination = `test-${randomUUID()}`;
  await pool.query(
    `INSERT INTO auth_challenges (id, destination, code_hash, expires_at, attempts)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, $5)`,
    [id, destination, hashCode(code, id, pepper!), options.expired ? -5 : 5, options.attempts ?? 0]
  );
  return id;
}

const attemptsOn = async (id: string) => {
  const { rows } = await pool.query<{ attempts: number; consumed_at: Date | null }>(
    `SELECT attempts, consumed_at FROM auth_challenges WHERE id = $1`,
    [id]
  );
  return rows[0];
};

beforeAll(() => {
  if (!runnable) return;
  pool = createPool(url!);
});

afterAll(async () => {
  if (!runnable) return;
  await pool.end();
});

describeDb("verifying a code", () => {
  it("accepts the right one and hands back a working session", async () => {
    const id = await plant("123456");

    const outcome = await verifyCode(id, "123456");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The token works, and it identifies the owner rather than anybody.
    expect(await sessionUser(outcome.token)).toMatch(/^tg-/u);
  });

  /**
   * The attempt has to land on the row, not just in memory.
   *
   * A wrong guess that does not increment is an unlimited guess, and six digits
   * fall in under a second to something that can try for ever. This is the
   * assertion that would catch the counter being updated on an object that is
   * then thrown away.
   */
  it("records a wrong guess against the challenge", async () => {
    const id = await plant("123456");

    expect((await verifyCode(id, "000000")).ok).toBe(false);
    expect((await attemptsOn(id))?.attempts).toBe(1);

    expect((await verifyCode(id, "111111")).ok).toBe(false);
    expect((await attemptsOn(id))?.attempts).toBe(2);
  });

  it("refuses a code that is out of attempts, even when it is right", async () => {
    const id = await plant("123456", { attempts: 5 });

    const outcome = await verifyCode(id, "123456");
    expect(outcome.ok).toBe(false);
  });

  it("refuses an expired code", async () => {
    const id = await plant("123456", { expired: true });
    expect((await verifyCode(id, "123456")).ok).toBe(false);
  });

  /** Single use: the second presentation of a correct code is not a sign-in. */
  it("will not let one code be used twice", async () => {
    const id = await plant("123456");

    expect((await verifyCode(id, "123456")).ok).toBe(true);
    expect((await verifyCode(id, "123456")).ok).toBe(false);
  });

  it("refuses a challenge that does not exist", async () => {
    expect((await verifyCode(randomUUID(), "123456")).ok).toBe(false);
  });
});

describeDb("a session", () => {
  it("is unknown once signed out", async () => {
    const id = await plant("123456");
    const outcome = await verifyCode(id, "123456");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(await sessionUser(outcome.token)).toBeDefined();
    await signOut(outcome.token);
    expect(await sessionUser(outcome.token)).toBeUndefined();
  });

  it("is unknown when the token is wrong", async () => {
    expect(await sessionUser("not-a-real-token")).toBeUndefined();
    expect(await sessionUser(undefined)).toBeUndefined();
  });

  /**
   * The stored form must not be the cookie.
   *
   * A table holding usable tokens is a table whose leak is a break-in. This
   * asserts the row is a peppered hash — so an attacker who reads it still
   * cannot present anything.
   */
  it("stores a peppered hash rather than the token", async () => {
    const id = await plant("123456");
    const outcome = await verifyCode(id, "123456");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const { rows } = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM auth_sessions WHERE expires_at > now() ORDER BY created_at DESC LIMIT 1`
    );
    const stored = rows[0]?.token_hash ?? "";

    expect(stored).not.toBe(outcome.token);
    expect(stored).toBe(createHash("sha256").update(`${pepper!}:${outcome.token}`).digest("hex"));
    // And a plain unsalted hash would not match, so the pepper is doing work.
    expect(stored).not.toBe(createHash("sha256").update(outcome.token).digest("hex"));
  });

  it("expires", async () => {
    expect(SESSION_TTL_MS).toBeGreaterThan(0);
    const token = `expired-${randomUUID()}`;
    await pool.query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
       VALUES ($1, 'tg-test', now() - interval '1 minute')`,
      [createHash("sha256").update(`${pepper!}:${token}`).digest("hex")]
    );
    expect(await sessionUser(token)).toBeUndefined();
  });
});
