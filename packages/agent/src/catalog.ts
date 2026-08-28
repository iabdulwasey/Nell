/**
 * Model catalog.
 *
 * Nell is model-agnostic by construction: the router takes a catalog as data,
 * so a deployment points its tiers at whatever it has access to — a frontier
 * API, a cheaper provider, or something running on the operator's own hardware.
 * Self-hosters are not obliged to fund a particular vendor to run their own
 * assistant.
 *
 * Capabilities are declared rather than assumed. Escalating to a screenshot on a
 * model that cannot see is a silent failure, so `supportsVision` is checked
 * before the perception layer is allowed to escalate.
 */

import { z } from "zod";
import type { ModelCatalog, ModelSpec, ModelTier } from "./model-router.js";

export const providerSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "zhipu",
  "moonshot",
  "mistral",
  "openrouter",
  /** Anything OpenAI-compatible: Ollama, vLLM, LM Studio, a local gateway. */
  "self-hosted",
]);

export type Provider = z.infer<typeof providerSchema>;

export interface CatalogEntry extends ModelSpec {
  readonly provider: Provider;
  readonly displayName: string;
  /** Tiers this model is a sensible choice for. */
  readonly suitableFor: readonly ModelTier[];
}

/**
 * Reference catalog. Prices are per million tokens in minor units (cents), so
 * arithmetic stays integral.
 *
 * These are defaults, not a lock-in: a deployment can replace the whole list.
 * Prices move constantly — treat them as a starting point and verify before
 * relying on them for billing.
 */
export const REFERENCE_CATALOG: readonly CatalogEntry[] = [
  // Anthropic
  {
    id: "anthropic/claude-opus-5",
    provider: "anthropic",
    displayName: "Claude Opus 5",
    tier: "frontier",
    inputCostPerMillion: 500,
    outputCostPerMillion: 2500,
    supportsVision: true,
    suitableFor: ["frontier"],
  },
  {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    tier: "worker",
    inputCostPerMillion: 200,
    outputCostPerMillion: 1000,
    supportsVision: true,
    suitableFor: ["worker", "frontier"],
  },
  {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    tier: "nano",
    inputCostPerMillion: 100,
    outputCostPerMillion: 500,
    supportsVision: true,
    suitableFor: ["nano"],
  },

  // OpenAI
  {
    id: "openai/gpt-5.6",
    provider: "openai",
    displayName: "GPT-5.6",
    tier: "frontier",
    inputCostPerMillion: 500,
    outputCostPerMillion: 3000,
    supportsVision: true,
    suitableFor: ["frontier"],
  },
  {
    id: "openai/gpt-5.6-mini",
    provider: "openai",
    displayName: "GPT-5.6 mini",
    tier: "worker",
    inputCostPerMillion: 200,
    outputCostPerMillion: 1200,
    supportsVision: true,
    suitableFor: ["worker"],
  },

  // Google
  {
    id: "google/gemini-3.5-flash",
    provider: "google",
    displayName: "Gemini 3.5 Flash",
    tier: "worker",
    inputCostPerMillion: 150,
    outputCostPerMillion: 900,
    supportsVision: true,
    suitableFor: ["nano", "worker"],
  },

  // xAI
  {
    id: "xai/grok-4",
    provider: "xai",
    displayName: "Grok 4",
    tier: "worker",
    inputCostPerMillion: 300,
    outputCostPerMillion: 1500,
    supportsVision: true,
    suitableFor: ["worker", "frontier"],
  },

  // DeepSeek — strong reasoning per unit cost; no vision, so it cannot serve a
  // tier that may need to escalate to a screenshot.
  {
    id: "deepseek/deepseek-v3",
    provider: "deepseek",
    displayName: "DeepSeek V3",
    tier: "worker",
    inputCostPerMillion: 27,
    outputCostPerMillion: 110,
    supportsVision: false,
    suitableFor: ["nano", "worker"],
  },

  // Zhipu GLM
  {
    id: "zhipu/glm-4.6",
    provider: "zhipu",
    displayName: "GLM-4.6",
    tier: "worker",
    inputCostPerMillion: 60,
    outputCostPerMillion: 220,
    supportsVision: true,
    suitableFor: ["nano", "worker"],
  },

  // Moonshot Kimi — very large context, useful for long browsing transcripts.
  {
    id: "moonshot/kimi-k2",
    provider: "moonshot",
    displayName: "Kimi K2",
    tier: "worker",
    inputCostPerMillion: 60,
    outputCostPerMillion: 250,
    supportsVision: true,
    suitableFor: ["nano", "worker"],
  },

  // Self-hosted, OpenAI-compatible. Zero marginal token cost; the operator pays
  // in hardware instead.
  {
    id: "self-hosted/local",
    provider: "self-hosted",
    displayName: "Local model (OpenAI-compatible)",
    tier: "worker",
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
    supportsVision: false,
    suitableFor: ["nano", "worker", "frontier"],
  },
];

export type CatalogProblem =
  | { readonly kind: "missing-tier"; readonly tier: ModelTier }
  | { readonly kind: "frontier-cannot-see"; readonly modelId: string };

/**
 * Validate a catalog before it is used.
 *
 * The frontier tier must support vision: it is where perception escalates when
 * a page cannot be driven structurally, and escalating to a model that cannot
 * see a screenshot would fail silently at exactly the moment things are already
 * going wrong.
 */
export function validateCatalog(catalog: ModelCatalog): readonly CatalogProblem[] {
  const problems: CatalogProblem[] = [];

  for (const tier of ["nano", "worker", "frontier"] as const) {
    if (!catalog[tier]?.id) problems.push({ kind: "missing-tier", tier });
  }

  if (catalog.frontier && !catalog.frontier.supportsVision) {
    problems.push({ kind: "frontier-cannot-see", modelId: catalog.frontier.id });
  }

  return problems;
}

/**
 * A catalog whose entries carry their provider and capability metadata.
 * Assignable anywhere a `ModelCatalog` is expected, since `CatalogEntry`
 * extends `ModelSpec`.
 */
export type CatalogSelection = Readonly<Record<ModelTier, CatalogEntry>>;

/** Build a catalog from chosen model ids, for a settings screen to drive. */
export function buildCatalog(
  entries: readonly CatalogEntry[],
  selection: Readonly<Record<ModelTier, string>>
): CatalogSelection | undefined {
  const find = (id: string) => entries.find((entry) => entry.id === id);
  const nano = find(selection.nano);
  const worker = find(selection.worker);
  const frontier = find(selection.frontier);
  if (!nano || !worker || !frontier) return undefined;
  return { nano, worker, frontier };
}

/** Models a user may pick for a given tier, for the settings UI. */
export function optionsForTier(
  entries: readonly CatalogEntry[],
  tier: ModelTier
): readonly CatalogEntry[] {
  return entries.filter((entry) => entry.suitableFor.includes(tier));
}

export function explainProblem(problem: CatalogProblem): string {
  switch (problem.kind) {
    case "missing-tier":
      return `No model is configured for the ${problem.tier} tier.`;
    case "frontier-cannot-see":
      return `${problem.modelId} cannot process images, so it cannot serve the frontier tier — that tier handles pages which must be read visually.`;
  }
}
