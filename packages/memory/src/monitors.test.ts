import { describe, expect, it } from "vitest";
import {
  claimDue,
  completeRun,
  decideFire,
  digestOf,
  LEASE_MS,
  MAX_CLAIMS_PER_TICK,
  runPreCheck,
  type Monitor,
} from "./index.js";

const now = 1_800_000_000_000;

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: "m1",
    workspaceId: "personal:abc",
    label: "Nobu table",
    checkType: "availability-appeared",
    checkConfig: {},
    prompt: "Tell me a table opened.",
    everyMinutes: 30,
    nextRunAt: now - 1000,
    enabled: true,
    ...overrides,
  };
}

describe("claiming due monitors", () => {
  it("claims a monitor whose time has come", () => {
    const { claimed } = claimDue([monitor()], now);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.leaseExpiresAt).toBe(now + LEASE_MS);
  });

  it("ignores monitors that are not due yet or disabled", () => {
    const notYet = monitor({ id: "later", nextRunAt: now + 60_000 });
    const off = monitor({ id: "off", enabled: false });
    expect(claimDue([notYet, off], now).claimed).toHaveLength(0);
  });

  // Without this, two workers both message the user about the same event.
  it("will not claim a monitor someone else already holds", () => {
    const held = monitor({ leaseExpiresAt: now + 60_000 });
    expect(claimDue([held], now).claimed).toHaveLength(0);
  });

  it("reclaims a monitor whose lease expired, so a crash cannot strand it", () => {
    const stale = monitor({ leaseExpiresAt: now - 1 });
    expect(claimDue([stale], now).claimed).toHaveLength(1);
  });

  it("caps how many it takes per tick and prefers the most overdue", () => {
    const many = Array.from({ length: MAX_CLAIMS_PER_TICK + 10 }, (_, i) =>
      monitor({ id: `m${String(i)}`, nextRunAt: now - i })
    );
    const { claimed } = claimDue(many, now);
    expect(claimed).toHaveLength(MAX_CLAIMS_PER_TICK);
    // Most overdue first.
    expect(claimed[0]?.id).toBe(`m${String(MAX_CLAIMS_PER_TICK + 9)}`);
  });

  it("releases the lease and schedules the next run on completion", () => {
    const { monitors } = claimDue([monitor()], now);
    const after = completeRun(monitors, "m1", now);
    expect(after[0]?.leaseExpiresAt).toBeUndefined();
    expect(after[0]?.nextRunAt).toBe(now + 30 * 60 * 1000);
  });
});

describe("deterministic pre-checks", () => {
  // The cost firewall: a quiet tick must not invoke a model.
  it("detects a price at or below the threshold", () => {
    const m = monitor({ checkType: "price-below", checkConfig: { threshold: 100 } });
    expect(runPreCheck(m, 90).changed).toBe(true);
    expect(runPreCheck(m, 100).changed).toBe(true);
    expect(runPreCheck(m, 101).changed).toBe(false);
  });

  it("detects availability appearing", () => {
    const m = monitor({ checkType: "availability-appeared" });
    expect(runPreCheck(m, true).changed).toBe(true);
    expect(runPreCheck(m, false).changed).toBe(false);
  });

  it("detects a page changing against a known digest", () => {
    const original = "<html>a</html>";
    const m = monitor({
      checkType: "page-changed",
      checkConfig: { previousDigest: digestOf(original) },
    });
    expect(runPreCheck(m, original).changed).toBe(false);
    expect(runPreCheck(m, "<html>b</html>").changed).toBe(true);
  });

  it("treats a first-ever page observation as no change", () => {
    const m = monitor({ checkType: "page-changed", checkConfig: {} });
    expect(runPreCheck(m, "anything").changed).toBe(false);
  });

  it("matches inbox text case-insensitively", () => {
    const m = monitor({ checkType: "inbox-matches", checkConfig: { match: "refund" } });
    expect(runPreCheck(m, "Your REFUND has been processed").changed).toBe(true);
    expect(runPreCheck(m, "Your order shipped").changed).toBe(false);
  });
});

describe("deciding whether to speak", () => {
  it("stays silent when nothing changed", () => {
    expect(decideFire({ changed: false, digest: "d" }, [])).toEqual({
      fire: false,
      reason: "no-change",
    });
  });

  it("fires on a genuinely new finding", () => {
    const decision = decideFire({ changed: true, digest: "d1", summary: "Table open" }, []);
    expect(decision).toMatchObject({ fire: true, summary: "Table open" });
  });

  // Repeating yourself is how a proactive agent becomes noise.
  it("stays silent when it already reported this exact finding", () => {
    expect(decideFire({ changed: true, digest: "d1" }, ["d1"])).toEqual({
      fire: false,
      reason: "already-reported",
    });
  });

  it("fires again when the finding is different", () => {
    expect(decideFire({ changed: true, digest: "d2" }, ["d1"]).fire).toBe(true);
  });
});
