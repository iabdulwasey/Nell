/**
 * Per-user memory export.
 *
 * Memory lives in rows, but a user should be able to hold it in their hands:
 * download it, read it, edit it, keep it if they leave. That portability is the
 * difference between "we store your data" and "this is yours".
 *
 * The file layout follows the convention file-based agents established, because
 * it is a good one and it is already familiar:
 *
 *   USER.md    standing directives — rules to obey
 *   MEMORY.md  durable facts — things to recall
 *   TASKS.md   what the agent has actually done
 *
 * The split is not cosmetic. Directives and facts fail differently: a missed
 * fact prompts a question, a missed directive breaks a promise. Keeping them in
 * separate documents keeps that distinction legible to the model and the person.
 */

import type { Directive } from "./directives.js";
import { liveDirectives } from "./directives.js";
import type { LedgerEntry } from "./ledger.js";
import type { Preference } from "./preferences.js";
import { liveProfile } from "./preferences.js";

export interface MemoryExport {
  readonly workspaceId: string;
  /** Filename -> contents. Written to a zip, a directory, or an API response. */
  readonly files: Readonly<Record<string, string>>;
  readonly exportedAt: number;
}

export interface ExportOptions {
  readonly workspaceId: string;
  readonly preferences: readonly Preference[];
  readonly directives: readonly Directive[];
  readonly entries: readonly LedgerEntry[];
  readonly now: number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function exportMemory(options: ExportOptions): MemoryExport {
  const { workspaceId } = options;

  const directives = liveDirectives(options.directives, workspaceId);
  const userMd = [
    "# Rules",
    "",
    "Standing instructions Nell follows. Edit freely — these are obeyed on every task.",
    "",
    directives.length > 0
      ? directives.map((d) => `- **${d.kind}**: ${d.rule}`).join("\n")
      : "_No rules set._",
    "",
  ].join("\n");

  const facts = liveProfile(options.preferences, workspaceId);
  const byCategory = new Map<string, Preference[]>();
  for (const fact of facts) {
    const bucket = byCategory.get(fact.category) ?? [];
    bucket.push(fact);
    byCategory.set(fact.category, bucket);
  }

  const memoryMd = [
    "# What Nell knows about you",
    "",
    "Facts Nell recalls when they're relevant. Importance is shown in brackets;",
    "higher-importance facts survive when context is tight.",
    "",
    facts.length > 0
      ? [...byCategory.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([category, items]) => {
            const lines = items
              .sort((a, b) => b.importance - a.importance)
              .map((item) => `- ${item.key}: ${item.value} [${String(item.importance)}]`)
              .join("\n");
            return `## ${category}\n\n${lines}`;
          })
          .join("\n\n")
      : "_Nothing learned yet._",
    "",
  ].join("\n");

  const tasks = options.entries
    .filter((entry) => entry.workspaceId === workspaceId)
    .sort((a, b) => b.completedAt - a.completedAt);

  const tasksMd = [
    "# Task history",
    "",
    tasks.length > 0
      ? tasks
          .map((entry) => {
            const money =
              entry.amount !== undefined && entry.currency
                ? ` — ${entry.currency} ${(entry.amount / 100).toFixed(2)}`
                : "";
            const where = entry.merchant ? ` at ${entry.merchant}` : "";
            return `- ${isoDate(entry.completedAt)}: ${entry.objective}${where}${money} (${entry.outcome})`;
          })
          .join("\n")
      : "_No tasks yet._",
    "",
  ].join("\n");

  return {
    workspaceId,
    exportedAt: options.now,
    files: {
      "USER.md": userMd,
      "MEMORY.md": memoryMd,
      "TASKS.md": tasksMd,
    },
  };
}

/**
 * Parse an edited MEMORY.md back into facts.
 *
 * Round-tripping matters: an export nobody can re-import is a backup, not
 * portability. Unparseable lines are skipped rather than failing the whole
 * import — a person hand-editing a file will not match the format exactly, and
 * losing their other edits over one bad line would be hostile.
 */
export interface ParsedFact {
  readonly key: string;
  readonly value: string;
  readonly importance: number;
}

export function parseMemoryMarkdown(markdown: string): readonly ParsedFact[] {
  const facts: ParsedFact[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^-\s+([^:]+):\s*(.+?)(?:\s*\[(\d+)\])?\s*$/u.exec(line.trim());
    if (!match) continue;
    const [, key, value, importance] = match;
    if (!key || !value) continue;
    facts.push({
      key: key.trim(),
      value: value.trim(),
      importance: importance ? Number(importance) : 5,
    });
  }
  return facts;
}
