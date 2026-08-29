import { describe, expect, it } from "vitest";
import { ATTACKS, controlsAreLive, reportAttacks, runAttackSuite } from "./index.js";

describe("the adversarial suite", () => {
  /**
   * The gate. If this fails, a security property regressed and the report names
   * which one, what it guards, and why it exists.
   */
  it("refuses every attack", () => {
    const summary = runAttackSuite();
    expect(reportAttacks(summary)).toBe(`All ${String(summary.total)} attacks refused.`);
    expect(summary.succeeded).toEqual([]);
  });

  /**
   * A suite where everything is refused because nothing is reachable is a suite
   * that proves nothing. This asserts the controls still say yes to the ordinary
   * case, so a green run above means "refused the attack", not "refused
   * everything".
   */
  it("is not vacuous — the same controls permit ordinary work", () => {
    expect(controlsAreLive()).toBe(true);
  });

  it("covers every category of failure the design claims to prevent", () => {
    const categories = new Set(ATTACKS.map((attack) => attack.category));
    for (const category of [
      "prompt-injection",
      "unapproved-spend",
      "credential-exfiltration",
      "session-hijack",
      "code-execution",
      "tenant-isolation",
    ]) {
      expect(categories.has(category as never)).toBe(true);
    }
  });

  it("says what each attack guards, so it is expensive to delete casually", () => {
    for (const attack of ATTACKS) {
      expect(attack.guards.length).toBeGreaterThan(40);
    }
  });

  it("has no duplicate ids", () => {
    const ids = ATTACKS.map((attack) => attack.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the harness itself", () => {
  // An exception usually means the gate was never reached. Counting it as a
  // pass is how a suite goes green while protecting nothing.
  it("counts a check that throws as a failure, not a refusal", () => {
    const summary = runAttackSuite([
      {
        id: "explodes",
        name: "A check that throws",
        category: "prompt-injection",
        guards: "That an exception is never mistaken for a refusal by this harness.",
        refuses: () => {
          throw new Error("boom");
        },
      },
    ]);

    expect(summary.refused).toBe(0);
    expect(summary.succeeded[0]?.error).toContain("boom");
    expect(reportAttacks(summary)).toContain("threw: boom");
  });

  it("reports an attack that succeeded, with what it guards", () => {
    const summary = runAttackSuite([
      {
        id: "gets-through",
        name: "An attack that was not refused",
        category: "unapproved-spend",
        guards: "That a successful attack is reported loudly rather than counted quietly.",
        refuses: () => false,
      },
    ]);

    const report = reportAttacks(summary);
    expect(report).toContain("1 of 1 attacks SUCCEEDED");
    expect(report).toContain("gets-through");
    expect(report).toContain("guards:");
  });

  it("counts by category", () => {
    const summary = runAttackSuite();
    for (const [, counts] of Object.entries(summary.byCategory)) {
      expect(counts.refused).toBe(counts.total);
    }
  });
});
