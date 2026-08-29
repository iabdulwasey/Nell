/**
 * Changing an inbox.
 *
 * Reading mail is cheap and reversible. Changing it is neither, and the
 * combination that makes this dangerous is specific: bulk operations are the
 * useful ones ("clear out the newsletters"), an inbox is a channel strangers can
 * write into, and the damage from getting it wrong is silent. Nobody notices the
 * one archived message that mattered until the week it mattered.
 *
 * Four rules, each aimed at a way this goes wrong:
 *
 * 1. **Nothing is ever destroyed.** Archive and trash are reversible; permanent
 *    deletion is not, so it is simply not offered. There is no code path here
 *    that can lose a message, which means no bug in this file can either.
 *
 * 2. **Bulk is previewed before it happens.** An operation reports what it would
 *    touch — how many, and a sample — before it touches anything. "Archive 1,847
 *    messages?" is a question a person can answer; "archive my newsletters?" is
 *    not, because they cannot see what the agent matched.
 *
 * 3. **Bulk is approved above a threshold.** Tidying six messages does not need
 *    a conversation. Tidying six hundred does.
 *
 * 4. **Every change is recorded well enough to undo.** Not "we could probably
 *    reconstruct it" — the exact message ids and the exact labels removed, so
 *    undo is a replay rather than a guess.
 *
 * And the rule that comes from outside this file: a bulk operation whose only
 * justification is untrusted content is refused by the provenance gate. "Archive
 * all security alerts" is a sensible-sounding sentence and a perfect attack.
 */

import { z } from "zod";
import type { EmailMessage, MailQuery } from "./gmail.js";

/**
 * What may be done to a message.
 *
 * Note the absence of a permanent delete. Trash is a label change that the user
 * can undo from their own client for thirty days; deletion is a phone call to
 * support. The capability is not omitted for caution — it is omitted because
 * nothing an assistant does to an inbox is worth making irreversible.
 */
export const mailOperationSchema = z.enum([
  "archive",
  "trash",
  "mark-read",
  "mark-unread",
  "add-label",
  "remove-label",
  "star",
  "unstar",
]);

export type MailOperation = z.infer<typeof mailOperationSchema>;

/** Operations that change what the user will see in their inbox at a glance. */
const VISIBLE = new Set<MailOperation>(["archive", "trash"]);

export interface MailChange {
  readonly operation: MailOperation;
  readonly messageIds: readonly string[];
  /** Required for the label operations, ignored otherwise. */
  readonly label?: string;
}

/**
 * Above this, a bulk operation is confirmed before it runs.
 *
 * Tidying six messages does not need a conversation; tidying six hundred does.
 * The threshold is low on purpose — the cost of asking is a tap, and the cost of
 * not asking is an inbox someone has to reconstruct by hand.
 */
export const BULK_APPROVAL_THRESHOLD = 20;

/** Nothing touches more than this in one operation, approved or not. */
export const MAX_BATCH = 500;

export interface MailWriteProvider {
  readonly name: string;
  /** Messages a query would affect, for previewing. */
  preview(query: MailQuery, limit: number): Promise<readonly EmailMessage[]>;
  apply(change: MailChange): Promise<void>;
  /** Labels currently on a message, so a change can be undone exactly. */
  labelsOf(messageIds: readonly string[]): Promise<Readonly<Record<string, readonly string[]>>>;
}

export interface Plan {
  readonly operation: MailOperation;
  readonly label?: string;
  readonly matched: number;
  /** A handful of subjects, so the user can see what was actually matched. */
  readonly sample: readonly string[];
  readonly messageIds: readonly string[];
  readonly needsApproval: boolean;
  /** Set when the match was larger than one operation may touch. */
  readonly truncated: boolean;
}

export interface PlanOptions {
  readonly provider: MailWriteProvider;
  readonly query: MailQuery;
  readonly operation: MailOperation;
  readonly label?: string;
  readonly threshold?: number;
}

/**
 * Work out what an operation would do, without doing any of it.
 *
 * "Archive my newsletters?" is not a question a person can answer, because they
 * cannot see what the agent matched. "Archive these 1,847, including these six?"
 * is.
 */
export async function planChange(options: PlanOptions): Promise<Plan> {
  const messages = await options.provider.preview(options.query, MAX_BATCH + 1);
  const truncated = messages.length > MAX_BATCH;
  const selected = messages.slice(0, MAX_BATCH);

  return {
    operation: options.operation,
    label: options.label,
    matched: selected.length,
    // Subjects only. A preview that showed bodies would be a way to read the
    // whole inbox through an operation that is meant to tidy it.
    sample: selected.slice(0, 6).map((message) => message.subject),
    messageIds: selected.map((message) => message.id),
    needsApproval: selected.length >= (options.threshold ?? BULK_APPROVAL_THRESHOLD),
    truncated,
  };
}

/**
 * Describe a plan for a person.
 *
 * States the count first, because the count is the thing that decides whether
 * someone should look closer. A message that leads with the sample invites
 * skimming the examples and missing that there are two thousand of them.
 */
export function describePlan(plan: Plan): string {
  const verb: Record<MailOperation, string> = {
    archive: "Archive",
    trash: "Move to trash",
    "mark-read": "Mark as read",
    "mark-unread": "Mark as unread",
    "add-label": `Label as "${plan.label ?? ""}"`,
    "remove-label": `Remove the label "${plan.label ?? ""}" from`,
    star: "Star",
    unstar: "Unstar",
  };

  if (plan.matched === 0) return "Nothing matches that.";

  const head = `${verb[plan.operation]} ${String(plan.matched)} message${plan.matched === 1 ? "" : "s"}?`;
  const sample = plan.sample.map((subject) => `• ${subject}`).join("\n");
  const more = plan.truncated
    ? `\n\nThat is more than I will change at once — I will do the first ${String(MAX_BATCH)} and you can ask again.`
    : "";
  const reversible = VISIBLE.has(plan.operation)
    ? "\n\nNothing is deleted, and I can undo this."
    : "";

  return `${head}\n\n${sample}${more}${reversible}`;
}

export interface UndoRecord {
  readonly operation: MailOperation;
  readonly label?: string;
  readonly messageIds: readonly string[];
  /** Labels each message carried beforehand, so undo is exact. */
  readonly previousLabels: Readonly<Record<string, readonly string[]>>;
  readonly appliedAt: number;
}

export type ApplyOutcome =
  | { readonly ok: true; readonly changed: number; readonly undo: UndoRecord }
  | { readonly ok: false; readonly reason: string };

export interface ApplyOptions {
  readonly provider: MailWriteProvider;
  readonly plan: Plan;
  readonly approved: boolean;
  readonly now: number;
}

/**
 * Apply a planned change.
 *
 * The prior labels are captured before anything is applied, not after, and the
 * capture failing aborts the whole operation. An undo record written from the
 * post-change state would describe the state it created rather than the one it
 * replaced — which is worse than having no undo at all, because it looks like
 * one.
 */
export async function applyChange(options: ApplyOptions): Promise<ApplyOutcome> {
  const { plan } = options;

  if (plan.matched === 0) return { ok: false, reason: "Nothing matched, so nothing changed." };
  if (plan.needsApproval && !options.approved) {
    return {
      ok: false,
      reason: `That would change ${String(plan.matched)} messages, so I need you to confirm it first.`,
    };
  }
  if ((plan.operation === "add-label" || plan.operation === "remove-label") && !plan.label) {
    return { ok: false, reason: "That operation needs a label." };
  }

  let previousLabels: Readonly<Record<string, readonly string[]>>;
  try {
    previousLabels = await options.provider.labelsOf(plan.messageIds);
  } catch (error) {
    return {
      ok: false,
      reason: `I could not record how to undo this, so I have not done it: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }

  try {
    await options.provider.apply({
      operation: plan.operation,
      messageIds: plan.messageIds,
      label: plan.label,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The mail provider refused that.",
    };
  }

  return {
    ok: true,
    changed: plan.matched,
    undo: {
      operation: plan.operation,
      label: plan.label,
      messageIds: plan.messageIds,
      previousLabels,
      appliedAt: options.now,
    },
  };
}

/**
 * Put things back.
 *
 * Replays the recorded prior labels rather than inverting the operation. An
 * inverse is a guess about what the state used to be; the record is what it
 * actually was, including labels this operation never touched.
 */
export async function undoChange(
  provider: MailWriteProvider,
  record: UndoRecord
): Promise<ApplyOutcome> {
  try {
    for (const [messageId, labels] of Object.entries(record.previousLabels)) {
      await provider.apply({
        operation: "add-label",
        messageIds: [messageId],
        label: labels.join(","),
      });
    }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Could not undo that.",
    };
  }

  return { ok: true, changed: record.messageIds.length, undo: record };
}

/**
 * Find messages that were probably filed as spam by mistake.
 *
 * The one read-ish operation that belongs here, because acting on it is the
 * point: a booking confirmation in the spam folder is a task that silently
 * failed. Matched on sender rather than content — content matching in a spam
 * folder means reading attacker-authored text to decide what to rescue, which is
 * the wrong direction entirely.
 */
export function likelyMisfiled(
  spam: readonly EmailMessage[],
  knownSenders: readonly string[]
): readonly EmailMessage[] {
  const known = new Set(knownSenders.map((sender) => sender.toLowerCase()));
  const domains = new Set(
    knownSenders.map((sender) => sender.toLowerCase().split("@")[1]).filter(Boolean)
  );

  return spam.filter((message) => {
    const from = message.from.toLowerCase();
    if (known.has(from)) return true;
    const domain = from.split("@")[1];
    return domain !== undefined && domains.has(domain);
  });
}
