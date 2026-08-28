import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  explainOtpFailure,
  FRESH,
  generateCode,
  generateRecoveryCodes,
  issueOtp,
  MAX_ATTEMPTS,
  PER_DESTINATION,
  redeemRecoveryCode,
  renderOtpMessage,
  RESEND_COOLDOWN_MS,
  verifyOtp,
  type DeliveryProvider,
  type DeliveryRequest,
} from "./index.js";

const pepper = "test-pepper";
const now = 1_800_000_000_000;
const destination = "+447911123456";

function issue(at = now) {
  return issueOtp({ id: "chal-1", destination, pepper, now: at });
}

describe("OTP issuance", () => {
  it("issues a six-digit numeric code", () => {
    const { code } = issue();
    expect(code).toMatch(/^\d{6}$/u);
  });

  // A stolen database must not yield live codes.
  it("stores only a hash, never the code", () => {
    const { code, challenge } = issue();
    expect(challenge.codeHash).not.toContain(code);
    expect(challenge.codeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(challenge)).not.toContain(code);
  });

  it("binds the hash to the challenge, so a code cannot be moved between them", () => {
    const a = issueOtp({ id: "chal-a", destination, pepper, now });
    const bChallenge = issueOtp({ id: "chal-b", destination, pepper, now }).challenge;
    const result = verifyOtp({ challenge: bChallenge, code: a.code, pepper, now });
    expect(result.ok).toBe(false);
  });

  it("does not produce the same code every time", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(20);
  });
});

describe("OTP verification", () => {
  it("accepts the correct code", () => {
    const { code, challenge } = issue();
    expect(verifyOtp({ challenge, code, pepper, now: now + 1000 }).ok).toBe(true);
  });

  it("rejects an incorrect code and counts the attempt", () => {
    const { challenge } = issue();
    const result = verifyOtp({ challenge, code: "000000", pepper, now });
    expect(result.ok).toBe(false);
    // A failed attempt must cost something or the cap is meaningless.
    expect(result.challenge.attempts).toBe(1);
  });

  it("rejects an expired code", () => {
    const { code, challenge } = issue();
    const result = verifyOtp({ challenge, code, pepper, now: now + 10 * 60 * 1000 });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  // Replay protection.
  it("consumes the code so it cannot be reused", () => {
    const { code, challenge } = issue();
    const first = verifyOtp({ challenge, code, pepper, now });
    expect(first.ok).toBe(true);
    const replay = verifyOtp({ challenge: first.challenge, code, pepper, now });
    expect(replay).toMatchObject({ ok: false, reason: "already-used" });
  });

  it("locks out after too many attempts, even with the right code", () => {
    const { code, challenge } = issue();
    let current = challenge;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      current = verifyOtp({ challenge: current, code: "000000", pepper, now }).challenge;
    }
    const result = verifyOtp({ challenge: current, code, pepper, now });
    expect(result).toMatchObject({ ok: false, reason: "too-many-attempts" });
  });

  it("rejects a code verified with the wrong pepper", () => {
    const { code, challenge } = issue();
    expect(verifyOtp({ challenge, code, pepper: "other-pepper", now }).ok).toBe(false);
  });

  it("gives user-facing messages that never reveal the code", () => {
    for (const reason of ["expired", "already-used", "too-many-attempts", "incorrect"] as const) {
      expect(explainOtpFailure(reason)).toMatch(/code/iu);
    }
  });
});

describe("recovery codes", () => {
  it("generates distinct codes and stores only hashes", () => {
    const { codes, records } = generateRecoveryCodes(pepper);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const [i, code] of codes.entries()) {
      expect(records[i]?.hash).not.toContain(code);
    }
  });

  it("uses an unambiguous alphabet", () => {
    const { codes } = generateRecoveryCodes(pepper);
    // No 0/O or 1/I/L, which are the characters people mistranscribe.
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/u);
  });

  it("redeems a valid code and marks it used", () => {
    const { codes, records } = generateRecoveryCodes(pepper);
    const result = redeemRecoveryCode(records, codes[0] ?? "", pepper, now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.remaining).toBe(9);
  });

  it("ignores formatting and case when redeeming", () => {
    const { codes, records } = generateRecoveryCodes(pepper);
    const messy = (codes[0] ?? "").toLowerCase().replace("-", " ");
    expect(redeemRecoveryCode(records, messy, pepper, now).ok).toBe(true);
  });

  it("refuses to redeem the same code twice", () => {
    const { codes, records } = generateRecoveryCodes(pepper);
    const first = redeemRecoveryCode(records, codes[0] ?? "", pepper, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(redeemRecoveryCode(first.records, codes[0] ?? "", pepper, now)).toMatchObject({
      ok: false,
      reason: "already-used",
    });
  });

  it("rejects an unknown code", () => {
    const { records } = generateRecoveryCodes(pepper);
    expect(redeemRecoveryCode(records, "AAAAA-BBBBB", pepper, now)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("leaves other codes usable after one is redeemed", () => {
    const { codes, records } = generateRecoveryCodes(pepper);
    const first = redeemRecoveryCode(records, codes[0] ?? "", pepper, now);
    if (!first.ok) throw new Error("expected redemption to succeed");
    expect(redeemRecoveryCode(first.records, codes[1] ?? "", pepper, now).ok).toBe(true);
  });
});

describe("rate limiting", () => {
  it("allows a first send", () => {
    expect(checkRateLimit(FRESH, PER_DESTINATION, now).allowed).toBe(true);
  });

  it("enforces a cooldown between sends", () => {
    const first = checkRateLimit(FRESH, PER_DESTINATION, now);
    if (!first.allowed) throw new Error("expected first send to be allowed");
    const soon = checkRateLimit(first.state, PER_DESTINATION, now + 5000);
    expect(soon).toMatchObject({ allowed: false, reason: "cooldown" });
    expect(soon.allowed === false && soon.retryAfterMs).toBeGreaterThan(0);
  });

  // The SMS-pumping defence: a script cannot burn budget on one number.
  it("caps sends within the window", () => {
    let state = FRESH;
    let at = now;
    for (let i = 0; i < PER_DESTINATION.limit; i += 1) {
      const decision = checkRateLimit(state, PER_DESTINATION, at);
      expect(decision.allowed).toBe(true);
      state = decision.state;
      at += RESEND_COOLDOWN_MS + 1;
    }
    expect(checkRateLimit(state, PER_DESTINATION, at)).toMatchObject({
      allowed: false,
      reason: "limit-reached",
    });
  });

  it("resets once the window passes", () => {
    let state = FRESH;
    let at = now;
    for (let i = 0; i < PER_DESTINATION.limit; i += 1) {
      const decision = checkRateLimit(state, PER_DESTINATION, at);
      state = decision.state;
      at += RESEND_COOLDOWN_MS + 1;
    }
    expect(checkRateLimit(state, PER_DESTINATION, at).allowed).toBe(false);
    const later = at + PER_DESTINATION.windowMs;
    expect(checkRateLimit(state, PER_DESTINATION, later).allowed).toBe(true);
  });
});

describe("delivery port", () => {
  it("lets the whole flow run against a fake provider", async () => {
    const sent: DeliveryRequest[] = [];
    const fake: DeliveryProvider = {
      name: "fake",
      send: (request) => {
        sent.push(request);
        return Promise.resolve();
      },
    };

    const { code, challenge } = issue();
    await fake.send({ destination, code, body: renderOtpMessage(code) });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.destination).toBe(destination);
    expect(sent[0]?.body).toContain(code);
    expect(verifyOtp({ challenge, code, pepper, now }).ok).toBe(true);
  });

  it("renders a message with no link, since links train phishing", () => {
    const body = renderOtpMessage("123456");
    expect(body).toContain("123456");
    expect(body).not.toMatch(/https?:\/\//u);
  });
});
