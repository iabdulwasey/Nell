import { describe, expect, it } from "vitest";
import {
  allowOrigin,
  beginPairing,
  completePairing,
  confirmPairing,
  defaultPolicy,
  describeActivity,
  evaluate,
  explainLocalRefusal,
  explainPairingFailure,
  halt,
  isUsable,
  resume,
  revokeDevice,
  revokeOrigin,
  setPresence,
  DEFAULT_SESSION_LIMIT_MS,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_CODE_DIGITS,
  PAIRING_TTL_MS,
  type CompanionAction,
  type LocalPolicy,
} from "./index.js";

const NOW = 1_700_000_000_000;
const PEPPER = "pepper";

function begin() {
  return beginPairing({
    workspaceId: "ws-1",
    deviceLabel: "Ada's MacBook",
    pepper: PEPPER,
    now: NOW,
  });
}

/** A policy with everything permitted, so each test can remove one thing. */
function permissive(overrides: Partial<LocalPolicy> = {}): LocalPolicy {
  return {
    ...defaultPolicy(),
    allowedOrigins: ["https://air.example"],
    userPresent: true,
    sessionStartedAt: NOW,
    ...overrides,
  };
}

const click: CompanionAction = { action: "click", x: 10, y: 10 };

describe("pairing needs a person at both ends", () => {
  it("shows a code short enough to read off a screen", () => {
    const { code } = begin();
    expect(code).toHaveLength(PAIRING_CODE_DIGITS);
    expect(code).toMatch(/^\d+$/u);
  });

  it("never stores the code itself", () => {
    const { request, code } = begin();
    expect(JSON.stringify(request)).not.toContain(code);
  });

  /**
   * A request confirmed only by the server is a stranger who guessed; one
   * confirmed only by the device is a device nobody asked for.
   */
  it("is not paired until both sides confirm", () => {
    const { request, code } = begin();

    const deviceOnly = confirmPairing(request, {
      code,
      side: "device",
      pepper: PEPPER,
      now: NOW + 1000,
    });
    expect(deviceOnly.ok).toBe(false);
    if (!deviceOnly.ok) expect(deviceOnly.reason).toBe("not-confirmed-both-sides");

    const both = confirmPairing(deviceOnly.request, {
      code,
      side: "user",
      pepper: PEPPER,
      now: NOW + 2000,
    });
    expect(both.ok).toBe(true);
  });

  it("refuses a wrong code and counts the attempt", () => {
    const { request, code } = begin();
    const wrong = confirmPairing(request, {
      code: "000000",
      side: "user",
      pepper: PEPPER,
      now: NOW + 1000,
    });

    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("wrong-code");
    // The counter has to survive a wrong guess, or it counts nothing.
    expect(wrong.request.attempts).toBe(1);
    expect(code).not.toBe("000000");
  });

  it("burns the attempt after a few wrong guesses", () => {
    let current = begin().request;
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) {
      current = confirmPairing(current, {
        code: "000000",
        side: "user",
        pepper: PEPPER,
        now: NOW + 1000,
      }).request;
    }

    const result = confirmPairing(current, {
      code: "000000",
      side: "user",
      pepper: PEPPER,
      now: NOW + 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too-many-attempts");
  });

  it("expires", () => {
    const { request, code } = begin();
    const result = confirmPairing(request, {
      code,
      side: "user",
      pepper: PEPPER,
      now: NOW + PAIRING_TTL_MS,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("cannot be replayed once complete", () => {
    const { request, code } = begin();
    const first = confirmPairing(request, { code, side: "device", pepper: PEPPER, now: NOW + 1 });
    const second = confirmPairing(first.request, {
      code,
      side: "user",
      pepper: PEPPER,
      now: NOW + 2,
    });

    const again = confirmPairing(second.request, {
      code,
      side: "user",
      pepper: PEPPER,
      now: NOW + 3,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("already-paired");
  });

  it("explains every failure", () => {
    for (const reason of [
      "wrong-code",
      "expired",
      "too-many-attempts",
      "already-paired",
      "not-confirmed-both-sides",
    ] as const) {
      expect(explainPairingFailure(reason).length).toBeGreaterThan(10);
    }
  });
});

describe("a paired device", () => {
  function paired() {
    const { request } = begin();
    return completePairing({
      request: { ...request, confirmedByDevice: true, confirmedByUser: true },
      pepper: PEPPER,
      now: NOW,
    });
  }

  it("keeps only a hash of its token", () => {
    const { device, token } = paired();
    expect(JSON.stringify(device)).not.toContain(token);
  });

  /**
   * A device that agreed to be paired has not thereby agreed to be driven
   * anywhere in particular.
   */
  it("starts allowed to do nothing at all", () => {
    expect(paired().device.allowedOrigins).toEqual([]);
  });

  // Someone reaching for this is worried, and a revocation that takes effect at
  // the next heartbeat is not a revocation.
  it("is revocable, immediately and permanently", () => {
    const { device } = paired();
    expect(isUsable(device)).toBe(true);

    const revoked = revokeDevice(device, NOW + 1000);
    expect(isUsable(revoked)).toBe(false);
    // Revoking twice does not move the timestamp.
    expect(revokeDevice(revoked, NOW + 9999).revokedAt).toBe(NOW + 1000);
  });
});

describe("the companion refuses on its own authority", () => {
  /**
   * The property the whole feature rests on. If our servers were fully
   * compromised, the worst that could be done to a paired laptop is what that
   * laptop had already agreed to.
   */
  it("refuses a site the user never allowed, however the request arrives", () => {
    const decision = evaluate(click, {
      policy: permissive({ allowedOrigins: ["https://air.example"] }),
      currentOrigin: "https://bank.example",
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("origin-not-allowed");
      expect(decision.message).toContain("bank.example");
    }
  });

  // Checking only where the browser IS leaves navigation as the way round it.
  it("checks where a navigation is going, not only where it is", () => {
    const decision = evaluate(
      { action: "navigate", url: "https://evil.example/page" },
      { policy: permissive(), currentOrigin: "https://air.example", now: NOW }
    );
    expect(decision.ok).toBe(false);
  });

  it("allows an action on a site the user granted", () => {
    expect(
      evaluate(click, { policy: permissive(), currentOrigin: "https://air.example", now: NOW }).ok
    ).toBe(true);
  });

  it("refuses anything outside its narrow vocabulary", () => {
    const decision = evaluate({ action: "read-clipboard" } as unknown as CompanionAction, {
      policy: permissive(),
      currentOrigin: "https://air.example",
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("unsupported-action");
  });

  it("refuses everything once the device is unpaired", () => {
    const decision = evaluate(click, {
      policy: permissive(),
      currentOrigin: "https://air.example",
      now: NOW,
      deviceRevoked: true,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("device-revoked");
  });
});

describe("the user is present and can stop", () => {
  /**
   * A remote-control session with nobody watching is indistinguishable from
   * malware, and should be.
   */
  it("does nothing while the user is away", () => {
    const decision = evaluate(click, {
      policy: permissive({ userPresent: false }),
      currentOrigin: "https://air.example",
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("user-absent");
  });

  // Someone who pressed stop is not interested in why their request was
  // otherwise reasonable.
  it("checks the stop button before anything else", () => {
    const stopped = halt(permissive());
    const decision = evaluate(click, {
      policy: stopped,
      // Also on a disallowed origin — stop should still be the stated reason.
      currentOrigin: "https://bank.example",
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("halted");
  });

  it("needs a deliberate resume", () => {
    const stopped = halt(permissive());
    expect(stopped.sessionStartedAt).toBeUndefined();

    const resumed = resume(stopped, NOW);
    expect(
      evaluate(click, { policy: resumed, currentOrigin: "https://air.example", now: NOW }).ok
    ).toBe(true);
  });

  it("ends a session that has run its length", () => {
    const decision = evaluate(click, {
      policy: permissive({ sessionStartedAt: NOW - DEFAULT_SESSION_LIMIT_MS - 1 }),
      currentOrigin: "https://air.example",
      now: NOW,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("session-expired");
  });

  it("tracks presence in both directions", () => {
    expect(setPresence(defaultPolicy(), true).userPresent).toBe(true);
    expect(setPresence(permissive(), false).userPresent).toBe(false);
  });
});

describe("the allowlist lives on the device", () => {
  // A companion that ships with a useful default allowlist has chosen for them.
  it("starts empty", () => {
    expect(defaultPolicy().allowedOrigins).toEqual([]);
  });

  it("grants one origin at a time", () => {
    const policy = allowOrigin(defaultPolicy(), "https://air.example/some/path");
    expect(policy.allowedOrigins).toEqual(["https://air.example"]);
  });

  it("does not duplicate a grant", () => {
    const once = allowOrigin(defaultPolicy(), "https://air.example");
    expect(allowOrigin(once, "https://air.example").allowedOrigins).toHaveLength(1);
  });

  /**
   * A wildcard is what a user clicks when they are tired and what an attacker
   * asks for when they are patient.
   */
  it("has no wildcard to grant", () => {
    for (const attempt of ["*", "https://*", "https://*.example", "all", "https://*.*"]) {
      expect(allowOrigin(defaultPolicy(), attempt).allowedOrigins).toEqual([]);
    }
  });

  /**
   * `new URL("https://*")` parses and yields the literal origin `https://*`.
   * Storing it is not exploitable — nothing ever matches it — but a user who
   * typed it would get a companion that refuses everything and never says why.
   */
  it("still accepts the ordinary hostnames a person would type", () => {
    for (const attempt of [
      "https://air.example",
      "http://localhost:3000",
      "https://sub.domain.air.example/path?q=1",
    ]) {
      expect(allowOrigin(defaultPolicy(), attempt).allowedOrigins).toHaveLength(1);
    }
  });

  it("refuses a scheme that is not http(s)", () => {
    for (const attempt of ["file:///etc/passwd", "javascript:alert(1)"]) {
      expect(allowOrigin(defaultPolicy(), attempt).allowedOrigins).toEqual([]);
    }
  });

  it("takes a grant back", () => {
    const policy = allowOrigin(defaultPolicy(), "https://air.example");
    expect(revokeOrigin(policy, "https://air.example").allowedOrigins).toEqual([]);
  });
});

describe("what the user sees while it works", () => {
  /**
   * "Nell is working" tells someone nothing they can act on. Naming the site and
   * the action is what lets them notice it is on a page they did not expect.
   */
  it("names the action and the site", () => {
    expect(describeActivity(click, "https://air.example")).toBe("Clicking on air.example");
    expect(describeActivity({ action: "type", text: "x" }, "https://air.example")).toContain(
      "Typing on air.example"
    );
    expect(
      describeActivity({ action: "navigate", url: "https://shop.example/x" }, "https://air.example")
    ).toContain("shop.example");
  });

  it("has words for every action and every refusal", () => {
    for (const action of [
      click,
      { action: "scroll", amount: 100 },
      { action: "screenshot" },
      { action: "read-page" },
    ] as CompanionAction[]) {
      expect(describeActivity(action, "https://air.example").length).toBeGreaterThan(5);
    }

    for (const reason of [
      "halted",
      "user-absent",
      "origin-not-allowed",
      "session-expired",
      "unsupported-action",
      "device-revoked",
    ] as const) {
      expect(explainLocalRefusal(reason).length).toBeGreaterThan(5);
    }
  });
});
