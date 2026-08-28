/**
 * @nell/agent
 *
 * The coordinator/worker agent runtime: prompts, tool registry, the ModelRouter,
 * and the briefing composer. The coordinator owns the relationship and never
 * drives a browser or sees secrets; workers run one durable workflow per task.
 *
 * Governed by: docs/architecture.md
 */

export {
  CACHE_DISCOUNT,
  checkBudget,
  costOf,
  ESCALATE_AFTER_FAILURES,
  modelTierSchema,
  route,
  UsageMeter,
  type BudgetDecision,
  type BudgetState,
  type ModelCatalog,
  type ModelSpec,
  type ModelTier,
  type RouteDecision,
  type RouteRequest,
  type Usage,
} from "./model-router.js";
