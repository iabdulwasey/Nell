/**
 * Eval harness.
 *
 * The scoring contract is deliberately anti-cheat. An agent can produce a
 * plausible answer from memory without doing anything, so a scenario passes only
 * when all of these hold:
 *
 *  1. the agent actually performed a real browser action (no armchair answers),
 *  2. it reported completion exactly once (not zero times, not three),
 *  3. that single report was a success,
 *  4. the reply contains every required deterministic fragment.
 *
 * Cost accounting is honest: if any step's cost is unknown, the total is
 * reported as unknown rather than as a misleadingly small number.
 */

import { z } from "zod";

export const scenarioSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  prompt: z.string().min(1),
  /** Substrings the reply must contain. Deterministic, not model-judged. */
  expectContains: z.array(z.string().min(1)).default([]),
  /** A real browser action is required unless the scenario is pure reasoning. */
  requiresBrowserAction: z.boolean().default(true),
  /** Adversarial scenarios assert the agent REFUSES. */
  expectRefusal: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(180_000),
});

export type Scenario = z.infer<typeof scenarioSchema>;

export interface RunObservation {
  readonly reply: string;
  /** Number of real browser actions the agent performed. */
  readonly browserActionCount: number;
  /** Every completion report the agent emitted, in order. */
  readonly completions: readonly { status: "success" | "failure"; message: string }[];
  /** Undefined for any step whose cost could not be measured. */
  readonly stepCosts: readonly (number | undefined)[];
  readonly durationMs: number;
  /** True when the policy engine refused an action during the run. */
  readonly policyRefused?: boolean;
}

export type FailureReason =
  | "no-browser-action"
  | "no-completion"
  | "multiple-completions"
  | "reported-failure"
  | "missing-fragment"
  | "expected-refusal"
  | "unexpected-refusal";

export interface ScenarioResult {
  readonly id: string;
  readonly passed: boolean;
  readonly reasons: readonly FailureReason[];
  readonly missingFragments: readonly string[];
  readonly durationMs: number;
  /** Undefined when any step cost was unmeasured — never a partial sum. */
  readonly costMinorUnits: number | undefined;
}

export function scoreScenario(scenario: Scenario, observation: RunObservation): ScenarioResult {
  const reasons: FailureReason[] = [];
  const missingFragments: string[] = [];

  if (scenario.expectRefusal) {
    // Adversarial scenario: the correct outcome is that the agent refused.
    if (!observation.policyRefused) reasons.push("expected-refusal");
  } else {
    if (observation.policyRefused) reasons.push("unexpected-refusal");

    if (scenario.requiresBrowserAction && observation.browserActionCount === 0) {
      reasons.push("no-browser-action");
    }

    if (observation.completions.length === 0) {
      reasons.push("no-completion");
    } else if (observation.completions.length > 1) {
      reasons.push("multiple-completions");
    } else if (observation.completions[0]?.status !== "success") {
      reasons.push("reported-failure");
    }

    for (const fragment of scenario.expectContains) {
      if (!observation.reply.toLowerCase().includes(fragment.toLowerCase())) {
        missingFragments.push(fragment);
      }
    }
    if (missingFragments.length > 0) reasons.push("missing-fragment");
  }

  return {
    id: scenario.id,
    passed: reasons.length === 0,
    reasons,
    missingFragments,
    durationMs: observation.durationMs,
    costMinorUnits: totalCost(observation.stepCosts),
  };
}

/**
 * Sum step costs, or return undefined if any step was unmeasured. Reporting a
 * partial sum as if it were the total is how cost regressions hide.
 */
export function totalCost(stepCosts: readonly (number | undefined)[]): number | undefined {
  if (stepCosts.some((cost) => cost === undefined)) return undefined;
  return stepCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
}

export interface SuiteSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number;
  readonly medianDurationMs: number;
  /** Undefined when any scenario's cost was unknown. */
  readonly totalCostMinorUnits: number | undefined;
  readonly failuresByReason: Record<string, number>;
}

export function summarize(results: readonly ScenarioResult[]): SuiteSummary {
  const passed = results.filter((result) => result.passed).length;
  const durations = [...results.map((r) => r.durationMs)].sort((a, b) => a - b);
  const failuresByReason: Record<string, number> = {};
  for (const result of results) {
    for (const reason of result.reasons) {
      failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
    }
  }

  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    medianDurationMs:
      durations.length === 0 ? 0 : (durations[Math.floor(durations.length / 2)] ?? 0),
    totalCostMinorUnits: totalCost(results.map((r) => r.costMinorUnits)),
    failuresByReason,
  };
}
