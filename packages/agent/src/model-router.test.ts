import { describe, expect, it } from "vitest";
import {
  checkBudget,
  costOf,
  ESCALATE_AFTER_FAILURES,
  route,
  UsageMeter,
  type ModelCatalog,
} from "./model-router.js";

const catalog: ModelCatalog = {
  nano: {
    id: "nano-1",
    tier: "nano",
    inputCostPerMillion: 10,
    outputCostPerMillion: 40,
    supportsVision: false,
  },
  worker: {
    id: "worker-1",
    tier: "worker",
    inputCostPerMillion: 200,
    outputCostPerMillion: 1000,
    supportsVision: false,
  },
  frontier: {
    id: "frontier-1",
    tier: "frontier",
    inputCostPerMillion: 500,
    outputCostPerMillion: 2500,
    supportsVision: true,
  },
};

describe("routing", () => {
  it("uses the requested tier by default", () => {
    expect(route(catalog, { tier: "worker" })).toMatchObject({
      spec: catalog.worker,
      escalated: false,
      reason: "requested",
    });
  });

  it("escalates to frontier when vision is needed", () => {
    const decision = route(catalog, { tier: "worker", needsVision: true });
    expect(decision.spec).toBe(catalog.frontier);
    expect(decision.reason).toBe("vision");
  });

  it("does not escalate when the tier already supports vision", () => {
    expect(route(catalog, { tier: "frontier", needsVision: true }).reason).toBe("requested");
  });

  it("escalates after repeated failures", () => {
    expect(
      route(catalog, { tier: "worker", failureCount: ESCALATE_AFTER_FAILURES - 1 }).escalated
    ).toBe(false);
    expect(
      route(catalog, { tier: "worker", failureCount: ESCALATE_AFTER_FAILURES }).escalated
    ).toBe(true);
  });

  it("keeps a task escalated once promoted", () => {
    const decision = route(catalog, { tier: "nano", escalated: true });
    expect(decision.spec).toBe(catalog.frontier);
    expect(decision.reason).toBe("sticky-escalation");
  });
});

describe("cost", () => {
  it("prices input and output separately", () => {
    // 1M input @200 + 1M output @1000
    expect(costOf(catalog.worker, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(1200);
  });

  it("discounts cached input", () => {
    const uncached = costOf(catalog.worker, { inputTokens: 1_000_000, outputTokens: 0 });
    const cached = costOf(catalog.worker, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(uncached).toBe(200);
    expect(cached).toBeCloseTo(20, 6);
  });

  // The whole reason routing exists.
  it("makes the nano tier dramatically cheaper than frontier", () => {
    const usage = { inputTokens: 500_000, outputTokens: 20_000 };
    expect(costOf(catalog.nano, usage)).toBeLessThan(costOf(catalog.frontier, usage) / 10);
  });

  it("never counts cached tokens twice", () => {
    const cost = costOf(catalog.worker, {
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 5000,
    });
    // Cached exceeds total input; fresh must floor at zero, not go negative.
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

describe("budget circuit breaker", () => {
  it("allows a call inside the ceiling", () => {
    expect(checkBudget({ spentMinorUnits: 100, ceilingMinorUnits: 1000 }, 50)).toMatchObject({
      allowed: true,
      remaining: 900,
    });
  });

  it("refuses once the ceiling is reached", () => {
    expect(checkBudget({ spentMinorUnits: 1000, ceilingMinorUnits: 1000 }, 1).allowed).toBe(false);
  });

  it("refuses a call that would overshoot, before making it", () => {
    expect(checkBudget({ spentMinorUnits: 900, ceilingMinorUnits: 1000 }, 200).allowed).toBe(false);
  });
});

describe("UsageMeter", () => {
  it("accumulates spend and breaks it down per model", () => {
    const meter = new UsageMeter();
    meter.record(catalog.worker, { inputTokens: 1_000_000, outputTokens: 0 });
    meter.record(catalog.nano, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(meter.spent).toBe(210);
    expect(meter.breakdown()).toEqual({ "worker-1": 200, "nano-1": 10 });
  });
});
