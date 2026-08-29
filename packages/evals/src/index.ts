/**
 * @nell/evals
 *
 * The anti-cheat eval harness and scenario packs: a pass requires a real browser
 * action, exactly-one successful completion report, and deterministic reply
 * fragments — with honest cost accounting that never presents a partial sum as a
 * total.
 *
 * Governed by: docs/roadmap.md
 */

export {
  scenarioSchema,
  scoreScenario,
  summarize,
  totalCost,
  type FailureReason,
  type RunObservation,
  type Scenario,
  type ScenarioResult,
  type SuiteSummary,
} from "./harness.js";

export {
  adversarialScenarios,
  allScenarios,
  retrievalScenarios,
  transactionalScenarios,
} from "./scenarios.js";

export {
  ATTACKS,
  controlsAreLive,
  reportAttacks,
  runAttackSuite,
  type Attack,
  type AttackCategory,
  type AttackResult,
  type AttackSuiteSummary,
} from "./attacks.js";
