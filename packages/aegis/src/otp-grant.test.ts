import { describe, expect, it } from "vitest";
import {
  explainOtpDenial,
  markOtpUsed,
  mintOtpGrant,
  otpApprovalPrompt,
  redeemOtpGrant,
  OTP_GRANT_TTL_MS,
  OTP_MESSAGE_WINDOW_MS,
  type CandidateMessage,
  type OtpGrant,
} from "./index.js";

const NOW = 1_700_000_000_000;
const PEPPER = "pepper";
const ORIGIN = "https://bank.example";

function mint(overrides: Partial<Parameters<typeof mintOtpGrant>[0]> = {}) {
  return mintOtpGrant({
    workspaceId: "ws-1",
    origin: ORIGIN,
    taskId: "task-1",
    pepper: PEPPER,
    now: NOW,
    ...overrides,
  });
}

const codeFromBank: CandidateMessage = {
  from: "no-reply@bank.example",
  senderDomain: "bank.example",
  receivedAt: NOW - 20_000,
  code: "482913",
};

function redeem(
  grant: OtpGrant,
  token: string,
  overrides: Partial<Parameters<typeof redeemOtpGrant>[1]> = {}
) {
  return redeemOtpGrant([grant], {
    token,
    workspaceId: "ws-1",
    origin: ORIGIN,
    pepper: PEPPER,
    now: NOW + 5000,
    messages: [codeFromBank],
    ...overrides,
  });
}

describe("what the grant actually buys", () => {
  /**
   * The property the whole design rests on. The approval does not unlock the
   * inbox — it unlocks a function whose entire output is digits. A six-digit
   * code has no room in it for an instruction, which is exactly why scoped
   * extraction is safe where free-text access is not.
   */
  it("returns a code and nothing else", () => {
    const { grant, token } = mint();
    const decision = redeem(grant, token);

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.code).toBe("482913");
      expect(decision.code).toMatch(/^\d{4,8}$/u);
    }
  });

  // A function that CAN return prose is one someone will eventually use to
  // return prose.
  it("has no shape in which a message body could travel", () => {
    const { grant, token } = mint();
    const decision = redeem(grant, token, {
      messages: [
        {
          ...codeFromBank,
          // A real message carries an instruction alongside the code.
          from: "no-reply@bank.example",
        },
      ],
    });

    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(Object.keys(decision)).toEqual(["ok", "code", "grant"]);
    }
  });
});

describe("the grant is a credential", () => {
  it("stores only a peppered hash of the token", () => {
    const { grant, token } = mint();
    expect(JSON.stringify(grant)).not.toContain(token);
  });

  it("refuses a guessed token", () => {
    const { grant } = mint();
    expect(redeem(grant, "guess")).toEqual({ ok: false, reason: "unknown-token" });
  });

  it("refuses a second use", () => {
    const { grant, token } = mint();
    expect(redeem(markOtpUsed(grant, NOW + 100), token)).toEqual({
      ok: false,
      reason: "already-used",
    });
  });

  it("expires", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { now: NOW + OTP_GRANT_TTL_MS })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is bound to the workspace that approved it", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { workspaceId: "ws-other" })).toEqual({
      ok: false,
      reason: "wrong-workspace",
    });
  });

  it("reports having no permission at all", () => {
    expect(
      redeemOtpGrant([], {
        token: "x",
        workspaceId: "ws-1",
        origin: ORIGIN,
        pepper: PEPPER,
        now: NOW,
        messages: [],
      })
    ).toEqual({ ok: false, reason: "no-grant" });
  });
});

describe("the grant is bound to one site", () => {
  // A grant approved for a bank is not a grant to read a code while the browser
  // sits on an attacker's page.
  it("refuses when the browser is somewhere else", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { origin: "https://evil.example" })).toEqual({
      ok: false,
      reason: "wrong-origin",
    });
  });

  it("checks the live origin, never one a model asserted", () => {
    const { grant, token } = mint();
    // Same host, different scheme: not the same origin.
    expect(redeem(grant, token, { origin: "http://bank.example" }).ok).toBe(false);
  });

  it("refuses a lookalike host", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { origin: "https://bank-example.com" }).ok).toBe(false);
  });

  it("cannot be minted against a malformed origin", () => {
    expect(() => mint({ origin: "not a url" })).toThrow(/origin/iu);
  });
});

describe("which message counts", () => {
  // A code from last week is not the code this login is waiting for.
  it("ignores messages older than the window", () => {
    const { grant, token } = mint();
    expect(
      redeem(grant, token, {
        messages: [{ ...codeFromBank, receivedAt: NOW - OTP_MESSAGE_WINDOW_MS - 60_000 }],
      })
    ).toEqual({ ok: false, reason: "message-too-old" });
  });

  // Stops the ordinary case of an unrelated code being handed over because it
  // happened to be the newest thing in the inbox.
  it("refuses a code from an unrelated sender", () => {
    const { grant, token } = mint();
    expect(
      redeem(grant, token, {
        messages: [
          {
            from: "promo@shopping.example",
            senderDomain: "shopping.example",
            receivedAt: NOW,
            code: "111111",
          },
        ],
      })
    ).toEqual({ ok: false, reason: "sender-mismatch" });
  });

  // Refusing numeric senders would break SMS 2FA entirely, which is most of the
  // cases this exists for.
  it("accepts a shortcode sender, which carries no domain", () => {
    const { grant, token } = mint();
    const decision = redeem(grant, token, {
      messages: [{ from: "+447700900123", receivedAt: NOW, code: "224466" }],
    });
    expect(decision.ok).toBe(true);
  });

  it("takes the newest code when one was re-sent", () => {
    const { grant, token } = mint();
    const decision = redeem(grant, token, {
      messages: [
        { ...codeFromBank, code: "111111", receivedAt: NOW - 60_000 },
        { ...codeFromBank, code: "222222", receivedAt: NOW - 5000 },
      ],
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.code).toBe("222222");
  });

  it("says plainly when nothing has arrived", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { messages: [] })).toEqual({ ok: false, reason: "no-code-found" });
  });

  it("refuses something that is not a code", () => {
    const { grant, token } = mint();
    expect(redeem(grant, token, { messages: [{ ...codeFromBank, code: "not-a-code" }] })).toEqual({
      ok: false,
      reason: "no-code-found",
    });
  });
});

describe("what the user is asked", () => {
  /**
   * A prompt that says only "allow access to your email?" asks for something far
   * larger than what is needed, and teaching someone to say yes to that is its
   * own harm.
   */
  it("names the site and the limit, not just the permission", () => {
    const prompt = otpApprovalPrompt(ORIGIN);

    expect(prompt).toContain("bank.example");
    expect(prompt).toContain("just the code");
    expect(prompt).toContain("not read anything else");
    expect(prompt).toContain("ends as soon as I use it");
  });

  it("explains every refusal", () => {
    for (const reason of [
      "no-grant",
      "unknown-token",
      "expired",
      "already-used",
      "wrong-workspace",
      "wrong-origin",
      "message-too-old",
      "sender-mismatch",
      "no-code-found",
    ] as const) {
      expect(explainOtpDenial(reason).length).toBeGreaterThan(10);
    }
  });

  // A wrong-workspace token and an unknown token must read identically, or the
  // message tells an attacker they guessed a real one.
  it("does not reveal whether a token existed", () => {
    expect(explainOtpDenial("wrong-workspace")).toBe(explainOtpDenial("unknown-token"));
  });
});
