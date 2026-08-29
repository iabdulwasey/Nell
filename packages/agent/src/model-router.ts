/**
 * Model router and cost metering.
 *
 * Frontier tokens dominate the cost of running an agent, so routing is
 * architecture rather than a later optimisation. Three tiers:
 *
 * - `nano`     cheap classification, steering, monitor pre-checks
 * - `worker`   the default for browsing and task execution
 * - `frontier` the coordinator, and any worker that has escalated
 *
 * Escalation is automatic and bounded: after repeated failures, or when a task
 * needs vision, a worker is promoted for the rest of that task. Every call is
 * metered per workspace, and a workspace that blows through its ceiling trips a
 * circuit breaker instead of quietly running up a bill.
 */

import { z } from "zod";

export const modelTierSchema = z.enum(["nano", "worker", "frontier"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export interface ModelSpec {
  readonly id: string;
  readonly tier: ModelTier;
  /** Cost per million tokens, in minor units, so arithmetic stays integral. */
  readonly inputCostPerMillion: number;
  readonly outputCostPerMillion: number;
  readonly supportsVision: boolean;
  /**
   * How much the model can hold, in tokens.
   *
   * Recorded because it is what actually runs out. The conversation window was
   * a hand-picked 3,000 tokens — an arbitrary number for a quantity that varies
   * by two orders of magnitude across this catalog, which threw away turns a
   * 200,000-token model could comfortably have kept. Prices were here from the
   * start and capacity was not, which is the same omission the capability map
   * had: the catalog described what a model *costs* and not what it can *do*.
   */
  readonly contextWindow: number;
}

/**
 * Catalog is data, not code, so a self-hoster can point tiers at whatever models
 * they have access to (including local ones) without touching the router.
 */
export type ModelCatalog = Readonly<Record<ModelTier, ModelSpec>>;

export interface RouteRequest {
  readonly tier: ModelTier;
  /** Consecutive failures on this task so far. */
  readonly failureCount?: number;
  /** The step needs to look at a screenshot. */
  readonly needsVision?: boolean;
  /** Caller has already escalated this task; keep it escalated. */
  readonly escalated?: boolean;
}

export interface RouteDecision {
  readonly spec: ModelSpec;
  readonly escalated: boolean;
  readonly reason: "requested" | "vision" | "failure-escalation" | "sticky-escalation";
}

/** Failures on one task before promoting it to the frontier tier. */
export const ESCALATE_AFTER_FAILURES = 2;

export function route(catalog: ModelCatalog, request: RouteRequest): RouteDecision {
  const frontier = catalog.frontier;

  if (request.escalated) {
    return { spec: frontier, escalated: true, reason: "sticky-escalation" };
  }
  if (request.needsVision && !catalog[request.tier].supportsVision) {
    return { spec: frontier, escalated: true, reason: "vision" };
  }
  if ((request.failureCount ?? 0) >= ESCALATE_AFTER_FAILURES) {
    return { spec: frontier, escalated: true, reason: "failure-escalation" };
  }
  return { spec: catalog[request.tier], escalated: false, reason: "requested" };
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Portion of input served from cache, billed at a fraction of list price. */
  readonly cachedInputTokens?: number;
}

/** Cached input is an order of magnitude cheaper; model it explicitly. */
export const CACHE_DISCOUNT = 0.1;

/**
 * Cost in minor units. Returns a fractional value; callers round only at
 * presentation time so long runs do not accumulate rounding error.
 */
export function costOf(spec: ModelSpec, usage: Usage): number {
  const cached = usage.cachedInputTokens ?? 0;
  const fresh = Math.max(0, usage.inputTokens - cached);
  const inputCost =
    (fresh * spec.inputCostPerMillion + cached * spec.inputCostPerMillion * CACHE_DISCOUNT) /
    1_000_000;
  const outputCost = (usage.outputTokens * spec.outputCostPerMillion) / 1_000_000;
  return inputCost + outputCost;
}

export interface BudgetState {
  readonly spentMinorUnits: number;
  readonly ceilingMinorUnits: number;
}

export type BudgetDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly reason: string };

/**
 * Circuit breaker. A runaway loop is bounded by the workspace's ceiling rather
 * than by hope, and the breaker trips before the call rather than after.
 */
export function checkBudget(state: BudgetState, projectedCost: number): BudgetDecision {
  const remaining = state.ceilingMinorUnits - state.spentMinorUnits;
  if (remaining <= 0) {
    return { allowed: false, reason: "This workspace has reached its usage limit." };
  }
  if (projectedCost > remaining) {
    return {
      allowed: false,
      reason: "This step would exceed the workspace's remaining usage budget.",
    };
  }
  return { allowed: true, remaining };
}

/** Running total for one workspace. Persisted by the caller. */
export class UsageMeter {
  #spent = 0;
  readonly #records: { model: string; cost: number }[] = [];

  record(spec: ModelSpec, usage: Usage): number {
    const cost = costOf(spec, usage);
    this.#spent += cost;
    this.#records.push({ model: spec.id, cost });
    return cost;
  }

  get spent(): number {
    return this.#spent;
  }

  /** Per-model breakdown, for the cost dashboard and eval reporting. */
  breakdown(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const record of this.#records) {
      totals[record.model] = (totals[record.model] ?? 0) + record.cost;
    }
    return totals;
  }
}
