import { describe, expect, it } from "vitest";
import {
  buildCatalog,
  explainProblem,
  optionsForTier,
  providerSchema,
  REFERENCE_CATALOG,
  validateCatalog,
  type CatalogEntry,
} from "./index.js";

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "test/model",
    provider: "self-hosted",
    displayName: "Test",
    tier: "worker",
    inputCostPerMillion: 100,
    outputCostPerMillion: 500,
    supportsVision: true,
    contextWindow: 128_000,
    suitableFor: ["worker"],
    ...overrides,
  };
}

describe("model agnosticism", () => {
  // Nobody should have to fund a particular vendor to run their own assistant.
  it("covers every provider a deployment might choose", () => {
    const providers = new Set(REFERENCE_CATALOG.map((model) => model.provider));
    for (const provider of [
      "anthropic",
      "openai",
      "google",
      "xai",
      "deepseek",
      "zhipu",
      "moonshot",
      "self-hosted",
    ] as const) {
      expect(providers.has(provider)).toBe(true);
    }
  });

  it("accepts OpenAI-compatible self-hosted models at zero token cost", () => {
    const local = REFERENCE_CATALOG.find((model) => model.provider === "self-hosted");
    expect(local?.inputCostPerMillion).toBe(0);
    expect(local?.suitableFor).toContain("frontier");
  });

  it("validates provider names", () => {
    expect(providerSchema.safeParse("deepseek").success).toBe(true);
    expect(providerSchema.safeParse("not-a-provider").success).toBe(false);
  });

  it("offers only models suited to each tier", () => {
    for (const tier of ["nano", "worker", "frontier"] as const) {
      const options = optionsForTier(REFERENCE_CATALOG, tier);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) expect(option.suitableFor).toContain(tier);
    }
  });
});

describe("catalog assembly", () => {
  it("builds a catalog from chosen model ids", () => {
    const catalog = buildCatalog(REFERENCE_CATALOG, {
      nano: "deepseek/deepseek-v3",
      worker: "zhipu/glm-4.6",
      frontier: "anthropic/claude-opus-5",
    });
    expect(catalog?.frontier.displayName).toBe("Claude Opus 5");
    expect(catalog?.nano.provider).toBe("deepseek");
  });

  it("lets tiers be mixed across providers", () => {
    const catalog = buildCatalog(REFERENCE_CATALOG, {
      nano: "moonshot/kimi-k2",
      worker: "xai/grok-4",
      frontier: "openai/gpt-5.6",
    });
    expect(
      new Set([catalog?.nano.provider, catalog?.worker.provider, catalog?.frontier.provider]).size
    ).toBe(3);
  });

  it("returns nothing for an unknown model id", () => {
    expect(
      buildCatalog(REFERENCE_CATALOG, {
        nano: "nope/nope",
        worker: "zhipu/glm-4.6",
        frontier: "anthropic/claude-opus-5",
      })
    ).toBeUndefined();
  });
});

describe("catalog validation", () => {
  const sighted = entry({ supportsVision: true });

  it("accepts a complete catalog", () => {
    expect(validateCatalog({ nano: sighted, worker: sighted, frontier: sighted })).toHaveLength(0);
  });

  // Escalating to a screenshot on a model that cannot see is a silent failure
  // at exactly the moment the task is already going wrong.
  it("refuses a frontier tier that cannot process images", () => {
    const problems = validateCatalog({
      nano: sighted,
      worker: sighted,
      frontier: entry({ id: "deepseek/deepseek-v3", supportsVision: false }),
    });
    expect(problems).toContainEqual({
      kind: "frontier-cannot-see",
      modelId: "deepseek/deepseek-v3",
    });
    expect(explainProblem(problems[0]!)).toMatch(/cannot process images/iu);
  });

  it("permits a text-only model on the cheaper tiers", () => {
    const textOnly = entry({ supportsVision: false });
    expect(validateCatalog({ nano: textOnly, worker: textOnly, frontier: sighted })).toHaveLength(
      0
    );
  });

  it("reports a tier that was never configured", () => {
    const problems = validateCatalog({
      nano: undefined as unknown as CatalogEntry,
      worker: sighted,
      frontier: sighted,
    });
    expect(problems).toContainEqual({ kind: "missing-tier", tier: "nano" });
  });
});
