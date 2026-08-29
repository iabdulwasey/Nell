import { describe, expect, it } from "vitest";
import {
  buildIndex,
  cosineSimilarity,
  orphaned,
  searchMemory,
  rebuildIndex,
  recencyWeight,
  renderRecalled,
  RECENCY_HALF_LIFE_DAYS,
  stem,
  tokenize,
  type EmbeddingProvider,
  type SourceRecord,
} from "./index.js";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const sources: SourceRecord[] = [
  {
    kind: "preference",
    id: "p1",
    text: "Aisle seat, never the back row",
    at: NOW - 10 * DAY,
    importance: 8,
  },
  {
    kind: "preference",
    id: "p2",
    text: "No early flights before 09:00",
    at: NOW - 20 * DAY,
    importance: 7,
  },
  {
    kind: "ledger",
    id: "l1",
    text: "Booked BA117 to New York, seat 14C",
    at: NOW - 5 * DAY,
    importance: 5,
  },
  {
    kind: "ledger",
    id: "l2",
    text: "Cancelled gym membership at Fitness First",
    at: NOW - 40 * DAY,
    importance: 4,
  },
  {
    kind: "directive",
    id: "d1",
    text: "Always ask before spending over 50 pounds",
    at: NOW - 60 * DAY,
    importance: 10,
  },
];

describe("tokenizing", () => {
  it("keeps the words that carry meaning", () => {
    expect(tokenize("Booked BA117 to New York")).toEqual(["book", "ba117", "new", "york"]);
  });

  /**
   * An aggressive stop list throws away "no" and "not", and a preference of
   * "no early flights" indexed without its negation means the opposite of what
   * the user said.
   */
  /**
   * Without this, "did I book a flight" fails to match a record that says
   * "Booked BA117" — and a memory system that cannot connect those two is not
   * doing the one job it has.
   */
  it("connects tenses and plurals of the same word", () => {
    expect(stem("booked")).toBe("book");
    expect(stem("booking")).toBe("book");
    expect(stem("flights")).toBe("flight");
    expect(stem("cancelled")).toBe("cancel");
  });

  // "BA117" must not become "BA11".
  it("leaves codes and short words alone", () => {
    expect(stem("ba117")).toBe("ba117");
    expect(stem("14c")).toBe("14c");
    expect(stem("seat")).toBe("seat");
    expect(stem("gym")).toBe("gym");
  });

  it("keeps negations", () => {
    expect(tokenize("No early flights")).toContain("no");
    expect(tokenize("Not the back row")).toContain("not");
  });

  it("drops noise words and single characters", () => {
    expect(tokenize("the a of to in")).toEqual([]);
  });
});

describe("recall", () => {
  it("finds what bears on a query", async () => {
    const index = await buildIndex(sources);
    const results = searchMemory(index, "which seat did I book", { now: NOW });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.entry.sourceId).toBe("l1");
  });

  // "flight" in forty entries tells you almost nothing; "BA117" in one is the
  // whole answer.
  it("weights a rare term above a common one", async () => {
    const many: SourceRecord[] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        kind: "ledger" as const,
        id: `f${String(i)}`,
        text: "Checked a flight",
        at: NOW,
      })),
      { kind: "ledger", id: "rare", text: "Checked flight BA117", at: NOW },
    ];

    const index = await buildIndex(many);
    expect(searchMemory(index, "BA117", { now: NOW })[0]?.entry.sourceId).toBe("rare");
  });

  it("says which terms matched, so a UI can explain itself", async () => {
    const index = await buildIndex(sources);
    const results = searchMemory(index, "aisle seat", { now: NOW });
    expect(results[0]?.matched).toContain("aisle");
  });

  it("returns nothing rather than everything for an unrelated query", async () => {
    const index = await buildIndex(sources);
    expect(searchMemory(index, "photosynthesis", { now: NOW })).toEqual([]);
  });

  it("handles an empty index and an empty query", async () => {
    expect(searchMemory([], "anything", { now: NOW })).toEqual([]);
    expect(searchMemory(await buildIndex(sources), "the a of", { now: NOW })).toEqual([]);
  });

  it("respects the limit", async () => {
    const index = await buildIndex(sources);
    expect(
      searchMemory(index, "flights seat booked gym spending", { now: NOW, limit: 2 })
    ).toHaveLength(2);
  });
});

describe("recency", () => {
  // "Aisle seat" does not stop being true because a quarter passed.
  it("decays rather than cutting off", () => {
    expect(recencyWeight(NOW, NOW)).toBe(1);
    expect(recencyWeight(NOW - RECENCY_HALF_LIFE_DAYS * DAY, NOW)).toBeCloseTo(0.5, 5);
    expect(recencyWeight(NOW - 365 * DAY, NOW)).toBeGreaterThan(0);
  });

  it("prefers the newer of two equally relevant memories", async () => {
    const index = await buildIndex([
      { kind: "ledger", id: "old", text: "Booked a table at Rossi", at: NOW - 200 * DAY },
      { kind: "ledger", id: "new", text: "Booked a table at Rossi", at: NOW - 2 * DAY },
    ]);
    expect(searchMemory(index, "Rossi table", { now: NOW })[0]?.entry.sourceId).toBe("new");
  });

  it("lets importance outweigh a little age", async () => {
    const index = await buildIndex([
      { kind: "ledger", id: "trivial", text: "Spending limit noted", at: NOW, importance: 1 },
      {
        kind: "directive",
        id: "vital",
        text: "Spending limit noted",
        at: NOW - 30 * DAY,
        importance: 10,
      },
    ]);
    expect(searchMemory(index, "spending limit", { now: NOW })[0]?.entry.sourceId).toBe("vital");
  });
});

describe("semantic similarity is a supplement, not the ranking", () => {
  const provider: EmbeddingProvider = {
    embed: async (texts) => texts.map((text) => [text.length, text.split(" ").length, 1]),
  };

  it("attaches embeddings when a provider is configured", async () => {
    const index = await buildIndex(sources, provider);
    expect(index[0]?.embedding).toBeDefined();
  });

  /**
   * An exact term match is what the person meant. A purely semantic index
   * cheerfully returns three thematically-adjacent flights instead, which is
   * the failure people mean when they say semantic search "feels random".
   */
  it("does not let a fuzzy match outrank an exact one", async () => {
    const index = await buildIndex(
      [
        { kind: "ledger", id: "exact", text: "Booked BA117", at: NOW },
        { kind: "ledger", id: "adjacent", text: "Looked at flights to New York", at: NOW },
      ],
      provider
    );

    const results = searchMemory(index, "BA117", {
      now: NOW,
      queryEmbedding: [12, 2, 1],
      semanticWeight: 0.3,
    });
    expect(results[0]?.entry.sourceId).toBe("exact");
  });

  // Recall that is worse is survivable; recall that is absent is not.
  it("degrades to lexical when the provider fails", async () => {
    const index = await buildIndex(sources, {
      embed: async () => {
        throw new Error("embedding service down");
      },
    });

    expect(index).toHaveLength(sources.length);
    expect(index[0]?.embedding).toBeUndefined();
    expect(searchMemory(index, "aisle seat", { now: NOW }).length).toBeGreaterThan(0);
  });

  it("computes cosine similarity, and copes with degenerate vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("deletion is provable, not promised", () => {
  /**
   * The failure this tier is designed around: a user disconnected their mailbox
   * and found their mail still in a searchable corpus weeks later, because a
   * derived index had quietly become a second source of truth.
   */
  it("cannot retain anything whose source is gone", async () => {
    const before = await buildIndex(sources);
    expect(searchMemory(before, "gym membership", { now: NOW }).length).toBeGreaterThan(0);

    const remaining = sources.filter((source) => source.id !== "l2");
    const { index } = await rebuildIndex(before, remaining, NOW);

    expect(searchMemory(index, "gym membership", { now: NOW })).toEqual([]);
    expect(JSON.stringify(index)).not.toContain("Fitness First");
  });

  /**
   * A rebuild carries nothing over from the previous index. An incremental
   * updater is exactly where "revoke did not delete" comes from.
   */
  it("is a pure function of the live sources", async () => {
    const fabricated = await buildIndex([
      { kind: "ledger", id: "ghost", text: "Something nobody stored", at: NOW },
    ]);
    const { index } = await rebuildIndex(fabricated, sources, NOW);

    expect(index.map((entry) => entry.sourceId)).not.toContain("ghost");
    expect(index).toHaveLength(sources.length);
  });

  // "We deleted it" is a claim. A before-and-after with named sources is
  // something a user can check.
  it("issues a receipt naming what stopped existing", async () => {
    const before = await buildIndex(sources);
    const remaining = sources.filter((source) => source.id !== "l2" && source.id !== "p2");
    const { receipt } = await rebuildIndex(before, remaining, NOW);

    expect(receipt).toMatchObject({
      rebuiltAt: NOW,
      entriesBefore: 5,
      entriesAfter: 3,
    });
    expect([...receipt.removedSources].sort()).toEqual(["ledger:l2", "preference:p2"]);
  });

  it("reports nothing removed when nothing was", async () => {
    const before = await buildIndex(sources);
    const { receipt } = await rebuildIndex(before, sources, NOW);
    expect(receipt.removedSources).toEqual([]);
  });

  // Run after any deletion and on a sweep, so a derived copy cannot quietly
  // outlive what it came from.
  it("finds entries whose source no longer exists", async () => {
    const index = await buildIndex(sources);
    const stale = orphaned(
      index,
      sources.filter((source) => source.kind !== "ledger")
    );

    expect([...stale].map((entry) => entry.sourceId).sort()).toEqual(["l1", "l2"]);
    expect(orphaned(index, sources)).toEqual([]);
  });

  it("treats an id reused across source kinds as different things", async () => {
    const shared: SourceRecord[] = [
      { kind: "preference", id: "x", text: "Aisle seat", at: NOW },
      { kind: "ledger", id: "x", text: "Booked a flight", at: NOW },
    ];
    const index = await buildIndex(shared);

    const stale = orphaned(index, [shared[0]!]);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.sourceKind).toBe("ledger");
  });
});

describe("rendering for a prompt", () => {
  // A user asking why the agent believes something deserves an answer that is
  // not a guess.
  it("says where each memory came from", async () => {
    const index = await buildIndex(sources);
    const rendered = renderRecalled(searchMemory(index, "aisle seat spending", { now: NOW }));

    expect(rendered).toContain("they told me");
    expect(rendered).toMatch(/they asked me to|from a past task/u);
  });

  it("renders nothing when there is nothing", () => {
    expect(renderRecalled([])).toBe("");
  });
});
