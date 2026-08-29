import { describe, expect, it } from "vitest";
import { appendEntry, type AuditEntry } from "@nell/audit";
import { authorizeSpend, mintApproval, payloadHash, type PurchasePayload } from "@nell/aegis";
import { buildCatalog, REFERENCE_CATALOG } from "@nell/agent";
import {
  auditView,
  buildApprovalCard,
  cardMatches,
  describeKey,
  estimateMonthlyCost,
  explainPriceChange,
  formatAmount,
  groupTasks,
  looksLikeKey,
  machinePanel,
  memoryRow,
  renderApprovalCard,
  settingsProblems,
  tierPanel,
  vaultRow,
  type TaskSummary,
} from "./index.js";

const NOW = 1_700_000_000_000;

const payload: PurchasePayload = {
  merchant: "Rossi",
  items: [
    { description: "Dinner, table for two", quantity: 1, unitAmount: 8000 },
    { description: "Service", quantity: 1, unitAmount: 1000 },
  ],
  options: { date: "2026-09-04", time: "20:00" },
  // Lines sum to exactly this. Deliberate: the "no fee line" case needs a
  // payload where nothing is unaccounted for, and an inconsistent fixture would
  // quietly make that test assert the opposite of what it says.
  totalAmount: 9000,
  currency: "GBP",
};

describe("the approval card cannot lie about what is being approved", () => {
  /**
   * The property the whole spend gate rests on. If the figures a person read
   * are not the figures the hash commits to, they approved one thing and the
   * token authorizes another — and the gate would still work perfectly while
   * being theatre.
   */
  it("commits to the same payload it displays", () => {
    const card = buildApprovalCard(payload);

    // Rebuild the payload from ONLY what the card shows, and hash that.
    const reconstructed: PurchasePayload = {
      merchant: card.merchant,
      items: card.lines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitAmount: line.unitAmount,
      })),
      options: Object.fromEntries(card.options),
      totalAmount: card.total,
      currency: card.currency,
    };

    expect(payloadHash(reconstructed)).toBe(card.payloadHash);
  });

  it("binds to the same hash the spend gate will check", () => {
    const card = buildApprovalCard(payload);
    const token = mintApproval({ workspaceId: "ws-1", payload, now: NOW });

    expect(token.payloadHash).toBe(card.payloadHash);
    expect(authorizeSpend({ token, workspaceId: "ws-1", payload, now: NOW }).allowed).toBe(true);
  });

  // A total silently exceeding the visible lines is exactly the surprise the
  // approval exists to prevent.
  it("shows a fee the merchant added beyond the line items", () => {
    const withFee: PurchasePayload = { ...payload, totalAmount: 11_000 };
    const card = buildApprovalCard(withFee);

    expect(card.extra).toBe(2000);
    expect(renderApprovalCard(card)).toContain("Fees and extras: £20.00");
  });

  it("shows no fee line when the lines add up", () => {
    expect(renderApprovalCard(buildApprovalCard(payload))).not.toContain("Fees and extras");
  });

  it("shows every line and the options that change what is bought", () => {
    const rendered = renderApprovalCard(buildApprovalCard(payload));
    expect(rendered).toContain("Dinner, table for two");
    expect(rendered).toContain("Service");
    expect(rendered).toContain("date: 2026-09-04");
    expect(rendered).toContain("Total: £90.00");
  });

  // A person should never be asked "confirm?" without the number in front of it.
  it("never asks for approval without stating the amount", () => {
    const rendered = renderApprovalCard(buildApprovalCard(payload));
    const question = rendered.indexOf("Approve this exact amount?");
    expect(rendered.slice(0, question)).toContain("£90.00");
  });

  it("notices when the payload no longer matches the card", () => {
    const card = buildApprovalCard(payload);
    expect(cardMatches(card, payload)).toBe(true);
    expect(cardMatches(card, { ...payload, totalAmount: 12_000 })).toBe(false);
  });

  // "The price changed" makes someone hunt for the difference.
  it("says which way the price moved and by how much", () => {
    const message = explainPriceChange({
      previousTotal: 9500,
      newTotal: 11_700,
      currency: "GBP",
    });
    expect(message).toContain("£117.00");
    expect(message).toContain("£22.00 more");
  });
});

describe("money is never a float", () => {
  // 1999/100 is 19.990000000000002 in floating point, and a total that renders
  // wrongly on a purchase confirmation destroys trust out of all proportion.
  it("formats amounts exactly", () => {
    expect(formatAmount(1999, "GBP")).toBe("£19.99");
    expect(formatAmount(9500, "GBP")).toBe("£95.00");
    expect(formatAmount(5, "USD")).toBe("$0.05");
    expect(formatAmount(0, "EUR")).toBe("€0.00");
    expect(formatAmount(100_000_00, "USD")).toBe("$100000.00");
  });

  it("handles a refund", () => {
    expect(formatAmount(-2500, "GBP")).toBe("-£25.00");
  });

  it("falls back to the code for a currency it has no symbol for", () => {
    expect(formatAmount(1000, "SEK")).toBe("SEK 10.00");
  });
});

describe("the vault view", () => {
  const item = {
    id: "v1",
    kind: "login" as const,
    label: "Airline account",
    origins: ["https://air.example"],
    updatedAt: NOW,
  };

  // A value that reaches the browser has left the server, and every later
  // protection is decoration.
  it("carries no value, because the type has nowhere to put one", () => {
    const row = vaultRow(item);
    expect(JSON.stringify(row)).not.toMatch(/password|secret|cvc/iu.source.replace(/\|/gu, "|"));
    expect(Object.keys(row)).not.toContain("value");
    expect(row.placeholder).toBe("password stored");
  });

  it("says plainly that a CVC is not stored", () => {
    expect(vaultRow({ ...item, kind: "payment" }).placeholder).toContain("CVC never stored");
  });

  // A login that silently does nothing looks like a broken agent, not a missing
  // setting.
  it("flags an item that can never be filled", () => {
    expect(vaultRow({ ...item, origins: [] }).unusable).toBe(true);
    expect(vaultRow(item).unusable).toBe(false);
  });
});

describe("the audit view", () => {
  function chainOf(count: number): AuditEntry[] {
    const entries: AuditEntry[] = [];
    let previous: AuditEntry | undefined;
    for (let i = 0; i < count; i += 1) {
      previous = appendEntry(previous, {
        workspaceId: "ws-1",
        action: "vault.fill",
        subject: `item-${String(i)}`,
        at: new Date(NOW + i * 1000).toISOString(),
      });
      entries.push(previous);
    }
    return entries;
  }

  it("reports an intact chain", () => {
    const view = auditView(chainOf(3));
    expect(view.intact).toBe(true);
    expect(view.notice).toContain("chain intact");
  });

  it("says so when there is nothing yet", () => {
    expect(auditView([]).notice).toContain("Nothing recorded");
  });

  // A tamper-evident log nobody checks is just a log.
  it("verifies every time rather than waiting to be asked", () => {
    const entries = chainOf(3);
    const tampered = [...entries];
    tampered[1] = { ...entries[1]!, subject: "something-else" };

    const view = auditView(tampered);
    expect(view.intact).toBe(false);
    expect(view.notice).toContain("tampered with");
    expect(view.brokenAtSequence).toBe(2);
  });

  it("detects a removed entry, not only an edited one", () => {
    const entries = chainOf(4);
    const view = auditView([entries[0]!, entries[2]!, entries[3]!]);
    expect(view.intact).toBe(false);
  });
});

describe("the machine panel", () => {
  const machine = {
    state: "running" as const,
    createdAt: NOW - 30 * 86_400_000,
    lastUsedAt: NOW,
    tasksServed: 42,
  };

  // A destroy button that says "are you sure?" without saying what is lost is
  // not informed consent.
  it("says what destroying the machine actually costs", () => {
    const panel = machinePanel(machine, NOW);
    expect(panel.ageDays).toBe(30);
    expect(panel.destroyWarning).toContain("30 days old");
    expect(panel.destroyWarning).toContain("42 tasks");
    expect(panel.destroyWarning).toContain("signs you out");
    expect(panel.destroyWarning).toContain("cannot be undone");
  });

  it("counts a single task without saying '1 tasks'", () => {
    expect(machinePanel({ ...machine, tasksServed: 1 }, NOW).destroyWarning).toContain("1 task.");
  });

  it("describes a brand new machine sensibly", () => {
    expect(machinePanel({ ...machine, createdAt: NOW }, NOW).destroyWarning).toContain(
      "set up today"
    );
  });

  it("explains standby in terms of what the user will notice", () => {
    expect(machinePanel({ ...machine, state: "standby" }, NOW).status).toContain("wakes when you");
  });
});

describe("task triage", () => {
  const tasks: TaskSummary[] = [
    { id: "1", label: "Book dinner", state: "done", updatedAt: NOW - 5000 },
    { id: "2", label: "Renew passport", state: "blocked", updatedAt: NOW - 1000 },
    { id: "3", label: "Find flights", state: "running", updatedAt: NOW - 2000 },
    { id: "4", label: "Cancel gym", state: "failed", updatedAt: NOW - 3000 },
    { id: "5", label: "Track parcel", state: "queued", updatedAt: NOW - 4000 },
  ];

  it("puts what needs the user first", () => {
    expect(groupTasks(tasks).needsYou.map((task) => task.id)).toEqual(["2"]);
  });

  // A task waiting for a CAPTCHA has not gone wrong, and filing it with the
  // failures trains people to ignore the list that most needs them.
  it("keeps blocked separate from failed", () => {
    const groups = groupTasks(tasks);
    expect(groups.finished.map((task) => task.id)).toContain("4");
    expect(groups.finished.map((task) => task.id)).not.toContain("2");
  });

  it("shows the most recent first within each group", () => {
    expect(groupTasks(tasks).active.map((task) => task.id)).toEqual(["3", "5"]);
  });

  it("handles an empty list", () => {
    expect(groupTasks([])).toEqual({ needsYou: [], active: [], finished: [] });
  });
});

describe("the memory browser", () => {
  // "Revoke did not delete" is the specific failure that cost the incumbent its
  // trust.
  it("makes everything deletable, without exception", () => {
    for (const lineage of ["stated", "observed"] as const) {
      expect(
        memoryRow({ id: "m1", text: "Aisle seat", importance: 7, learnedAt: NOW, lineage })
          .deletable
      ).toBe(true);
    }
  });

  // "Why does it know that" should have an answer on the screen.
  it("says how it learned each thing", () => {
    expect(
      memoryRow({ id: "m1", text: "Aisle seat", importance: 7, learnedAt: NOW, lineage: "stated" })
        .because
    ).toContain("You told me");
    expect(
      memoryRow({
        id: "m2",
        text: "Prefers Rossi",
        importance: 5,
        learnedAt: NOW,
        lineage: "observed",
      }).because
    ).toContain("noticed");
  });
});

describe("model settings", () => {
  const keys = [{ provider: "anthropic" as const, hint: "…abcd", addedAt: NOW }];

  // An open agent that only works against one vendor's API is that vendor's
  // client program.
  it("offers every provider, not only the ones with keys", () => {
    const panel = tierPanel("worker", REFERENCE_CATALOG, keys);
    const providers = new Set(panel.options.map((option) => option.provider));
    expect(providers.size).toBeGreaterThan(5);
  });

  it("marks which options need a key this deployment does not have", () => {
    const panel = tierPanel("worker", REFERENCE_CATALOG, keys);
    expect(panel.options.find((o) => o.provider === "anthropic")?.needsKey).toBe(false);
    expect(panel.options.find((o) => o.provider === "openai")?.needsKey).toBe(true);
    // Local models are reached over an endpoint, not an API key.
    expect(panel.options.find((o) => o.provider === "self-hosted")?.needsKey).toBe(false);
  });

  // A list that silently omits things is a list a user cannot trust they have
  // read.
  it("shows an unpickable option with the reason rather than hiding it", () => {
    const panel = tierPanel("frontier", REFERENCE_CATALOG, keys);
    const deepseek = panel.options.find((option) => option.provider === "deepseek");

    expect(deepseek).toBeDefined();
    expect(deepseek?.unavailableBecause).toContain("Cannot see images");
  });

  it("prices a local model as hardware rather than as zero", () => {
    const panel = tierPanel("worker", REFERENCE_CATALOG, keys);
    expect(panel.options.find((o) => o.provider === "self-hosted")?.price).toBe("your hardware");
  });

  it("explains each tier in the user's terms", () => {
    for (const tier of ["nano", "worker", "frontier"] as const) {
      expect(tierPanel(tier, REFERENCE_CATALOG, keys).explanation.length).toBeGreaterThan(40);
    }
  });
});

describe("configuration problems surface before a task fails", () => {
  const selection = buildCatalog(REFERENCE_CATALOG, {
    nano: "anthropic/claude-haiku-4-5",
    worker: "anthropic/claude-sonnet-5",
    frontier: "anthropic/claude-opus-5",
  });

  it("is clean when everything is configured", () => {
    expect(
      settingsProblems(selection, [{ provider: "anthropic", hint: "…1234", addedAt: NOW }])
    ).toEqual([]);
  });

  it("blocks when no models are chosen", () => {
    expect(settingsProblems(undefined, [])[0]?.severity).toBe("blocking");
  });

  // Failing on the first task is worse than failing on the settings screen.
  it("warns about a provider with no key", () => {
    const problems = settingsProblems(selection, []);
    expect(problems.some((p) => p.severity === "warning")).toBe(true);
    expect(problems[0]?.message).toContain("anthropic");
  });

  it("does not warn twice about the same provider", () => {
    const problems = settingsProblems(selection, []);
    expect(problems.filter((p) => p.message.includes("anthropic"))).toHaveLength(1);
  });

  it("blocks a frontier model that cannot see", () => {
    const blind = buildCatalog(REFERENCE_CATALOG, {
      nano: "deepseek/deepseek-v3",
      worker: "deepseek/deepseek-v3",
      frontier: "deepseek/deepseek-v3",
    });
    const problems = settingsProblems(blind, []);
    expect(problems.some((p) => p.severity === "blocking")).toBe(true);
  });
});

describe("keys are credentials", () => {
  // A settings page that round-trips a key so the input can be pre-filled has
  // put a live credential in every browser the page was ever opened in.
  it("keeps only enough to tell two keys apart", () => {
    const stored = describeKey("openai", "sk-proj-abcdefghijklmnop1234", NOW);
    expect(stored.hint).toBe("…1234");
    expect(JSON.stringify(stored)).not.toContain("sk-proj");
  });

  it("does not leak a short key through the hint", () => {
    expect(describeKey("openai", "abc", NOW).hint).toBe("…");
  });

  it("rejects an empty or obviously wrong key before storing it", () => {
    expect(looksLikeKey("")).toBe(false);
    expect(looksLikeKey("short")).toBe(false);
    expect(looksLikeKey("sk-proj-abcdefghijklmnop1234")).toBe(true);
  });

  // Pasting the dashboard URL instead of the key is a common mistake.
  it("catches a pasted URL", () => {
    expect(looksLikeKey("https://platform.openai.com/api-keys")).toBe(false);
  });

  it("catches a key with whitespace in it", () => {
    expect(looksLikeKey("sk-proj abcdefghijklmnop")).toBe(false);
  });
});

describe("cost estimate", () => {
  // The point is that the difference is two orders of magnitude, not a rounding
  // error — visible before someone commits.
  it("shows a frontier configuration costing far more than a local one", () => {
    const frontier = buildCatalog(REFERENCE_CATALOG, {
      nano: "anthropic/claude-opus-5",
      worker: "anthropic/claude-opus-5",
      frontier: "anthropic/claude-opus-5",
    });
    const local = buildCatalog(REFERENCE_CATALOG, {
      nano: "self-hosted/local",
      worker: "self-hosted/local",
      frontier: "self-hosted/local",
    });

    expect(estimateMonthlyCost(frontier!, 100).minorUnits).toBeGreaterThan(0);
    expect(estimateMonthlyCost(local!, 100).minorUnits).toBe(0);
  });

  it("scales with how much the agent is used", () => {
    const selection = buildCatalog(REFERENCE_CATALOG, {
      nano: "anthropic/claude-haiku-4-5",
      worker: "anthropic/claude-sonnet-5",
      frontier: "anthropic/claude-opus-5",
    })!;
    expect(estimateMonthlyCost(selection, 200).minorUnits).toBeGreaterThan(
      estimateMonthlyCost(selection, 100).minorUnits
    );
  });

  // Presenting a rough number as precise is its own kind of lie.
  it("says it is rough", () => {
    const selection = buildCatalog(REFERENCE_CATALOG, {
      nano: "anthropic/claude-haiku-4-5",
      worker: "anthropic/claude-sonnet-5",
      frontier: "anthropic/claude-opus-5",
    })!;
    expect(estimateMonthlyCost(selection, 100).caveat).toContain("rough");
  });
});
