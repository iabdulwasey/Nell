/**
 * Directives — standing rules, kept deliberately apart from facts.
 *
 * File-based agents (OpenClaw, Hermes) split `USER.md` from `MEMORY.md`, and the
 * reason they give is worth stealing: preference adherence and fact recall fail
 * differently.
 *
 * A fact ("home airport is LHR") needs to be *recalled when relevant* — if it is
 * missed, the agent asks a question. A directive ("never call after 9pm") needs
 * to be *obeyed on every turn* — if it is missed, the agent does something the
 * user explicitly forbade. Mixing them into one list encourages a model to treat
 * a standing rule as trivia.
 *
 * So directives get their own store, their own prompt section, and — unlike
 * facts — they are never truncated away by a size budget.
 */

import type { Provenance } from "@nell/shared";
import { z } from "zod";

export const directiveKindSchema = z.enum(["always", "never", "prefer", "ask-first"]);
export type DirectiveKind = z.infer<typeof directiveKindSchema>;

export interface Directive {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: DirectiveKind;
  /** The rule itself, phrased as the user gave it. */
  readonly rule: string;
  readonly provenance: Provenance;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export const MAX_RULE_LENGTH = 300;

export type DirectiveRejection =
  | "untrusted-provenance"
  | "empty-rule"
  | "rule-too-long"
  | "duplicate";

export type DirectiveResult =
  | { readonly ok: true; readonly directives: readonly Directive[] }
  | { readonly ok: false; readonly reason: DirectiveRejection };

export interface AddDirectiveOptions {
  readonly existing: readonly Directive[];
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: DirectiveKind;
  readonly rule: string;
  readonly provenance: Provenance;
  readonly now: number;
}

function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase().replaceAll(/\s+/gu, " ");
}

export function addDirective(options: AddDirectiveOptions): DirectiveResult {
  // A directive is the strongest standing instruction a user can give, so an
  // untrusted source must never be able to plant one.
  if (options.provenance === "untrusted") {
    return { ok: false, reason: "untrusted-provenance" };
  }

  const rule = options.rule.trim();
  if (!rule) return { ok: false, reason: "empty-rule" };
  if (rule.length > MAX_RULE_LENGTH) return { ok: false, reason: "rule-too-long" };

  const normalized = normalizeRule(rule);
  const duplicate = options.existing.some(
    (directive) =>
      directive.workspaceId === options.workspaceId &&
      directive.revokedAt === undefined &&
      directive.kind === options.kind &&
      normalizeRule(directive.rule) === normalized
  );
  if (duplicate) return { ok: false, reason: "duplicate" };

  return {
    ok: true,
    directives: [
      ...options.existing,
      {
        id: options.id,
        workspaceId: options.workspaceId,
        kind: options.kind,
        rule,
        provenance: options.provenance,
        createdAt: options.now,
      },
    ],
  };
}

export function revokeDirective(
  directives: readonly Directive[],
  workspaceId: string,
  id: string,
  now: number
): readonly Directive[] {
  return directives.map((directive) =>
    directive.id === id &&
    directive.workspaceId === workspaceId &&
    directive.revokedAt === undefined
      ? { ...directive, revokedAt: now }
      : directive
  );
}

export function liveDirectives(
  directives: readonly Directive[],
  workspaceId: string
): readonly Directive[] {
  // Prohibitions first: the rules whose violation the user would most notice.
  const order: Record<DirectiveKind, number> = {
    never: 0,
    "ask-first": 1,
    always: 2,
    prefer: 3,
  };
  return directives
    .filter(
      (directive) => directive.workspaceId === workspaceId && directive.revokedAt === undefined
    )
    .sort((a, b) => order[a.kind] - order[b.kind] || a.createdAt - b.createdAt);
}

/**
 * Render directives for a prompt.
 *
 * Never truncated. A size budget that silently drops "never book non-refundable
 * fares" is worse than no budget at all, so if this section grows the fix is to
 * ask the user to prune it — not to quietly discard rules.
 */
export function renderDirectives(directives: readonly Directive[], workspaceId: string): string {
  const live = liveDirectives(directives, workspaceId);
  if (live.length === 0) return "";
  return live.map((directive) => `- ${label(directive.kind)}: ${directive.rule}`).join("\n");
}

function label(kind: DirectiveKind): string {
  switch (kind) {
    case "always":
      return "Always";
    case "never":
      return "Never";
    case "prefer":
      return "Prefer";
    case "ask-first":
      return "Ask first";
  }
}
