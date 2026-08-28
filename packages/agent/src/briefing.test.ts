import { addDirective, recordTask, writePreference } from "@nell/memory";
import type { Directive, LedgerEntry, Preference } from "@nell/memory";
import { describe, expect, it } from "vitest";
import { assertNoSecrets, composeBriefing, type VaultHandle } from "./index.js";

const workspaceId = "personal:abc";
const now = 1_800_000_000_000;

const directives: Directive[] = (() => {
  const result = addDirective({
    existing: [],
    id: "d1",
    workspaceId,
    kind: "never",
    rule: "book non-refundable fares",
    provenance: "user",
    now,
  });
  return result.ok ? [...result.directives] : [];
})();

const preferences: Preference[] = (() => {
  const result = writePreference({
    existing: [],
    id: "p1",
    workspaceId,
    key: "travel.home_airport",
    value: "LHR",
    category: "travel",
    provenance: "user",
    now,
  });
  return result.ok ? [...result.preferences] : [];
})();

const ledger: LedgerEntry[] = [
  recordTask({
    id: "l1",
    workspaceId,
    taskId: "t0",
    objective: "Book dinner for 4",
    outcome: "succeeded",
    merchant: "Nozomi",
    amount: 24_000,
    currency: "USD",
    now,
  }),
];

const handle: VaultHandle = {
  id: "vault-item-1",
  label: "Chase login",
  kind: "login",
  origins: ["https://chase.com"],
};

function brief(overrides: Partial<Parameters<typeof composeBriefing>[0]> = {}) {
  return composeBriefing({
    workspaceId,
    taskId: "t1",
    objective: "Book a table at Nozomi for 4 on Friday",
    directives,
    preferences,
    ledger,
    vaultHandles: [],
    ...overrides,
  });
}

describe("briefing composition", () => {
  it("always states the objective", () => {
    expect(brief().text).toContain("Book a table at Nozomi");
  });

  // A worker that reads the objective first is already reasoning about how to
  // achieve it; the prohibitions need to land before that.
  it("puts rules before the objective is elaborated", () => {
    const text = brief().text;
    expect(text.indexOf("Rules you must follow")).toBeLessThan(
      text.indexOf("What you know about this person")
    );
    expect(text).toContain("non-refundable");
  });

  it("includes relevant facts", () => {
    expect(brief().text).toContain("LHR");
  });

  it("includes what happened last time at this merchant", () => {
    const text = brief({ merchant: "Nozomi" }).text;
    expect(text).toContain("## Last time");
    expect(text).toContain("Nozomi");
  });

  it("omits precedents from other merchants", () => {
    expect(brief({ merchant: "Somewhere Else" }).text).not.toContain("## Last time");
  });

  it("states spend limits in human units", () => {
    const text = brief({ budget: { maxSpend: 25_000, currency: "USD" } }).text;
    expect(text).toContain("USD 250.00");
  });

  it("states a merchant allowlist when one applies", () => {
    const text = brief({ budget: { merchantAllowlist: ["Nozomi"] } }).text;
    expect(text).toContain("Only transact with: Nozomi");
  });

  it("omits empty sections rather than emitting headings with nothing under them", () => {
    const text = brief({ directives: [], preferences: [], ledger: [] }).text;
    expect(text).not.toContain("Rules you must follow");
    expect(text).not.toContain("What you know about this person");
    expect(text).not.toContain("Last time");
  });

  it("never includes another workspace's memory", () => {
    const text = composeBriefing({
      workspaceId: "personal:other",
      taskId: "t1",
      objective: "Do something",
      directives,
      preferences,
      ledger,
      vaultHandles: [],
    }).text;
    expect(text).not.toContain("LHR");
    expect(text).not.toContain("non-refundable");
  });
});

describe("credentials in briefings", () => {
  it("passes handles, never values", () => {
    const briefing = brief({ vaultHandles: [handle] });
    expect(briefing.text).toContain("vault-item-1");
    expect(briefing.text).toContain("Chase login");
    expect(briefing.handles).toHaveLength(1);
  });

  it("states where each credential may be used", () => {
    expect(brief({ vaultHandles: [handle] }).text).toContain("https://chase.com");
  });

  it("tells the worker it will never see the value", () => {
    expect(brief({ vaultHandles: [handle] }).text).toContain("never see these values");
  });

  // Cheap insurance against a future change interpolating a value where a
  // handle belongs — a regression that would be invisible until it mattered.
  it("refuses to dispatch a briefing containing a secret", () => {
    const leaky = composeBriefing({
      workspaceId,
      taskId: "t1",
      objective: "Log in with password hunter2xyz",
      directives: [],
      preferences: [],
      ledger: [],
      vaultHandles: [],
    });
    expect(() => {
      assertNoSecrets(leaky, ["hunter2xyz"]);
    }).toThrow(/secret value/iu);
  });

  it("passes a clean briefing", () => {
    expect(() => {
      assertNoSecrets(brief({ vaultHandles: [handle] }), ["hunter2xyz"]);
    }).not.toThrow();
  });

  it("ignores very short strings, which would match everywhere", () => {
    expect(() => {
      assertNoSecrets(brief(), ["a"]);
    }).not.toThrow();
  });
});
