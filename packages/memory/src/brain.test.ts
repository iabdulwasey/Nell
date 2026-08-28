import { describe, expect, it } from "vitest";
import {
  BrainCache,
  memoryVersion,
  recordTask,
  renderBrain,
  renderBrainCached,
  writePreference,
  type LedgerEntry,
  type Preference,
} from "./index.js";

const workspaceId = "personal:abc";
const now = 1_800_000_000_000;

function prefs(...specs: [key: string, value: string, category?: string][]): Preference[] {
  let current: readonly Preference[] = [];
  for (const [key, value, category] of specs) {
    const result = writePreference({
      existing: current,
      id: `p-${key}`,
      workspaceId,
      key,
      value,
      category: (category ?? "other") as Preference["category"],
      provenance: "user",
      now,
    });
    if (result.ok) current = result.preferences;
  }
  return [...current];
}

const entry: LedgerEntry = recordTask({
  id: "l1",
  workspaceId,
  taskId: "t1",
  objective: "Book dinner for 4",
  outcome: "succeeded",
  merchant: "Nozomi",
  amount: 24_000,
  currency: "USD",
  now,
});

describe("brain document", () => {
  it("renders preferences grouped by category", () => {
    const document = renderBrain({
      workspaceId,
      preferences: prefs(
        ["diet.restrictions", "pescatarian", "dietary"],
        ["travel.home_airport", "LHR", "travel"]
      ),
      entries: [],
      now,
    });

    expect(document.markdown).toContain("### Dietary");
    expect(document.markdown).toContain("### Travel");
    expect(document.markdown).toContain("pescatarian");
  });

  // "travel.home_airport" is a storage key; a person should not have to read it.
  it("humanizes keys for display", () => {
    const document = renderBrain({
      workspaceId,
      preferences: prefs(["travel.home_airport", "LHR", "travel"]),
      entries: [],
      now,
    });
    expect(document.markdown).toContain("Home airport: LHR");
    expect(document.markdown).not.toContain("travel.home_airport");
  });

  it("includes recent tasks", () => {
    const document = renderBrain({ workspaceId, preferences: [], entries: [entry], now });
    expect(document.markdown).toContain("## Recent tasks");
    expect(document.markdown).toContain("Nozomi");
  });

  it("says so plainly when it knows nothing", () => {
    const document = renderBrain({ workspaceId, preferences: [], entries: [], now });
    expect(document.markdown).toContain("Nothing remembered yet");
  });

  it("shows only live values, not superseded ones", () => {
    const first = writePreference({
      existing: [],
      id: "p1",
      workspaceId,
      key: "diet.restrictions",
      value: "vegetarian",
      category: "dietary",
      provenance: "user",
      now,
    });
    if (!first.ok) throw new Error("expected success");
    const second = writePreference({
      existing: first.preferences,
      id: "p2",
      workspaceId,
      key: "diet.restrictions",
      value: "pescatarian",
      category: "dietary",
      provenance: "user",
      now: now + 1,
    });
    if (!second.ok) throw new Error("expected success");

    const document = renderBrain({
      workspaceId,
      preferences: second.preferences,
      entries: [],
      now,
    });
    expect(document.markdown).toContain("pescatarian");
    expect(document.markdown).not.toContain("vegetarian");
  });

  it("never renders another workspace's memory", () => {
    const document = renderBrain({
      workspaceId: "personal:someone-else",
      preferences: prefs(["diet.restrictions", "pescatarian", "dietary"]),
      entries: [entry],
      now,
    });
    expect(document.markdown).not.toContain("pescatarian");
    expect(document.markdown).not.toContain("Nozomi");
  });

  it("bounds how many recent tasks it includes", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      recordTask({
        id: `e${String(i)}`,
        workspaceId,
        taskId: `t${String(i)}`,
        objective: `Task ${String(i)}`,
        outcome: "succeeded",
        now: now + i,
      })
    );
    const document = renderBrain({
      workspaceId,
      preferences: [],
      entries: many,
      now,
      recentTaskLimit: 3,
    });
    expect(document.markdown.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });
});

describe("version stamping", () => {
  it("is stable when nothing changed", () => {
    const preferences = prefs(["a", "1"]);
    expect(memoryVersion(preferences, [entry], workspaceId)).toBe(
      memoryVersion(preferences, [entry], workspaceId)
    );
  });

  it("changes when a preference changes", () => {
    const before = prefs(["a", "1"]);
    const after = prefs(["a", "1"], ["b", "2"]);
    expect(memoryVersion(before, [], workspaceId)).not.toBe(memoryVersion(after, [], workspaceId));
  });

  it("changes when a task is recorded", () => {
    expect(memoryVersion([], [], workspaceId)).not.toBe(memoryVersion([], [entry], workspaceId));
  });
});

describe("caching", () => {
  it("reuses the rendered document while memory is unchanged", () => {
    const cache = new BrainCache();
    const options = { workspaceId, preferences: prefs(["a", "1"]), entries: [], now };
    const first = renderBrainCached(cache, options);
    const second = renderBrainCached(cache, { ...options, now: now + 10_000 });
    // Same object identity proves it was not re-rendered.
    expect(second).toBe(first);
  });

  it("re-renders once memory changes", () => {
    const cache = new BrainCache();
    const first = renderBrainCached(cache, {
      workspaceId,
      preferences: prefs(["a", "1"]),
      entries: [],
      now,
    });
    const second = renderBrainCached(cache, {
      workspaceId,
      preferences: prefs(["a", "1"], ["b", "2"]),
      entries: [],
      now,
    });
    expect(second).not.toBe(first);
    expect(second.markdown).toContain("2");
  });

  it("keeps workspaces separate in the cache", () => {
    const cache = new BrainCache();
    renderBrainCached(cache, { workspaceId, preferences: prefs(["a", "1"]), entries: [], now });
    renderBrainCached(cache, {
      workspaceId: "personal:other",
      preferences: [],
      entries: [],
      now,
    });
    expect(cache.size).toBe(2);
  });

  it("evicts on request, which deletion depends on", () => {
    const cache = new BrainCache();
    renderBrainCached(cache, { workspaceId, preferences: prefs(["a", "1"]), entries: [], now });
    cache.evict(workspaceId);
    expect(cache.size).toBe(0);
  });
});
