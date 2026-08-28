/**
 * Worker briefings.
 *
 * A worker never sees the parent conversation. That is deliberate: the
 * conversation contains everything the user has ever said, and handing all of it
 * to a browser worker widens the blast radius of any injection on the page it
 * visits, while paying for the tokens on every step.
 *
 * Instead the coordinator composes a briefing: the objective, the rules that
 * must be obeyed, the facts that are relevant, what happened last time, and
 * opaque handles for any credentials needed. Everything a worker needs to act,
 * and nothing it needs to be told twice.
 *
 * The invariant this file exists to hold: **a briefing never contains a secret
 * value.** Only handles.
 */

import { renderDirectives, renderPrecedents, type Directive, type LedgerEntry } from "@nell/memory";
import { renderProfileDetailed, type Preference } from "@nell/memory";

/** A reference to a vault item. Never the value it protects. */
export interface VaultHandle {
  readonly id: string;
  /** Human label so the model can reason about which credential to use. */
  readonly label: string;
  readonly kind: "login" | "payment" | "address" | "identity" | "phone";
  /** Origins this credential may be filled into; enforced server-side. */
  readonly origins: readonly string[];
}

/** Hard limits the dispatcher enforces, stated so the worker can plan. */
export interface BudgetEnvelope {
  /** Spend ceiling in minor units. */
  readonly maxSpend?: number;
  readonly currency?: string;
  readonly maxWallClockMs?: number;
  /** Merchants the task may transact with, when constrained. */
  readonly merchantAllowlist?: readonly string[];
}

export interface BriefingInput {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly objective: string;
  readonly directives: readonly Directive[];
  readonly preferences: readonly Preference[];
  readonly ledger: readonly LedgerEntry[];
  readonly vaultHandles: readonly VaultHandle[];
  readonly budget?: BudgetEnvelope;
  /** Merchant this task concerns, used to pull the right precedent. */
  readonly merchant?: string;
}

export interface Briefing {
  readonly taskId: string;
  readonly text: string;
  /** Handles referenced, for the audit record of what the worker could reach. */
  readonly handles: readonly VaultHandle[];
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

/**
 * Compose the briefing.
 *
 * Order is chosen so the constraints a worker must not violate come before the
 * task it is eager to complete.
 */
export function composeBriefing(input: BriefingInput): Briefing {
  const sections: string[] = [`## Objective\n\n${input.objective}`];

  // Rules first. A worker that reads the objective before the prohibitions is
  // already reasoning about how to achieve it.
  const rules = renderDirectives(input.directives, input.workspaceId);
  if (rules) {
    sections.push(`## Rules you must follow\n\n${rules}`);
  }

  if (input.budget) {
    const lines: string[] = [];
    if (input.budget.maxSpend !== undefined) {
      lines.push(
        `- Never spend more than ${formatMoney(input.budget.maxSpend, input.budget.currency ?? "USD")} without a fresh approval.`
      );
    }
    if (input.budget.merchantAllowlist?.length) {
      lines.push(`- Only transact with: ${input.budget.merchantAllowlist.join(", ")}.`);
    }
    if (input.budget.maxWallClockMs !== undefined) {
      lines.push(
        `- Aim to finish within ${String(Math.round(input.budget.maxWallClockMs / 60_000))} minutes.`
      );
    }
    if (lines.length > 0) {
      sections.push(`## Limits\n\n${lines.join("\n")}`);
    }
  }

  const profile = renderProfileDetailed(input.preferences, input.workspaceId);
  if (profile.text) {
    sections.push(`## What you know about this person\n\n${profile.text}`);
  }

  const precedents = input.ledger
    .filter(
      (entry) =>
        entry.workspaceId === input.workspaceId &&
        (input.merchant === undefined || entry.merchant === input.merchant)
    )
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, 3);
  if (precedents.length > 0) {
    sections.push(`## Last time\n\n${renderPrecedents(precedents)}`);
  }

  if (input.vaultHandles.length > 0) {
    const lines = input.vaultHandles
      .map(
        (handle) =>
          `- ${handle.label} (${handle.kind}) — handle \`${handle.id}\`, usable on ${handle.origins.join(", ")}`
      )
      .join("\n");
    sections.push(
      `## Credentials\n\nYou never see these values. Ask the server to fill a handle into a\nfield; it checks the page's real origin before doing so.\n\n${lines}`
    );
  }

  return {
    taskId: input.taskId,
    text: sections.join("\n\n"),
    handles: input.vaultHandles,
  };
}

/**
 * Assert that a briefing carries no secret material.
 *
 * Called before dispatch. This is cheap insurance against a future change that
 * accidentally interpolates a value where a handle belongs — the kind of
 * regression that would be invisible until it mattered.
 */
export function assertNoSecrets(briefing: Briefing, knownSecretValues: readonly string[]): void {
  for (const secret of knownSecretValues) {
    if (secret.length >= 4 && briefing.text.includes(secret)) {
      throw new Error("A briefing contained a secret value. Dispatch refused.");
    }
  }
}
