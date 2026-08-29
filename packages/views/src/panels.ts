/**
 * Dashboard view models.
 *
 * Pure functions from state to what a screen shows. They live here rather than
 * inside components for one reason: the properties below are security
 * properties, and a security property asserted in a React component is a
 * security property nobody tests.
 *
 * What each panel is actually responsible for getting right:
 *
 * - **Vault** — never render a secret. Not truncated, not masked in CSS, not
 *   present in the props at all. A value that reaches the browser has left the
 *   server, and every later protection is decoration.
 * - **Audit** — surface a broken chain loudly. An audit log whose UI shows
 *   entries without checking the hashes is a log that reassures rather than
 *   attests.
 * - **Machine** — say how old it is and what it holds, because destroying it is
 *   irreversible and the user should know what they are throwing away.
 * - **Memory** — show what is remembered and let it be deleted, since "revoke
 *   did not delete" is the specific failure that burned the incumbent.
 */

import { verifyChain, type AuditEntry } from "@nell/audit";

/* -------------------------------------------------------------------------- */
/* Vault                                                                       */
/* -------------------------------------------------------------------------- */

export type VaultKind = "login" | "payment" | "address" | "identity" | "phone";

export interface VaultItemState {
  readonly id: string;
  readonly kind: VaultKind;
  readonly label: string;
  /** Origins this item may be filled on. The user's, not the model's. */
  readonly origins: readonly string[];
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
}

export interface VaultRow {
  readonly id: string;
  readonly kind: VaultKind;
  readonly label: string;
  readonly origins: readonly string[];
  readonly updatedAt: number;
  readonly lastUsedAt?: number;
  /** What the user sees where the value would be. Never the value. */
  readonly placeholder: string;
  /**
   * An item with no origins can never be filled. Surfaced because a login that
   * silently does nothing looks like a broken agent, not a missing setting.
   */
  readonly unusable: boolean;
}

const PLACEHOLDERS: Readonly<Record<VaultKind, string>> = {
  login: "password stored",
  payment: "card stored · CVC never stored",
  address: "address stored",
  identity: "identity details stored",
  phone: "number stored",
};

/**
 * Build a vault row.
 *
 * Takes state that has no secret in it. That is deliberate: the type makes it
 * impossible to pass a value in, so no future edit can leak one by adding a
 * field to a template.
 */
export function vaultRow(item: VaultItemState): VaultRow {
  return {
    ...item,
    placeholder: PLACEHOLDERS[item.kind],
    unusable: item.origins.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export interface AuditView {
  readonly entries: readonly AuditEntry[];
  /** False when the chain does not verify. */
  readonly intact: boolean;
  /** Where it first broke, when it broke. */
  readonly brokenAtSequence?: number;
  readonly notice: string;
}

/**
 * Build the audit panel.
 *
 * Verification runs here, every time, rather than being a button someone
 * remembers to press. A tamper-evident log that is not checked is just a log,
 * and the whole reason to hash-chain it is so that nobody has to be trusted to
 * check it.
 */
export function auditView(entries: readonly AuditEntry[]): AuditView {
  const result = verifyChain(entries);

  if (result.valid) {
    return {
      entries,
      intact: true,
      notice:
        entries.length === 0
          ? "Nothing recorded yet."
          : `${String(entries.length)} entries, chain intact.`,
    };
  }

  return {
    entries,
    intact: false,
    brokenAtSequence: result.brokenAt,
    // Deliberately alarming. This means an entry was altered or removed after
    // it was written, and a quiet notice would be the wrong response.
    notice:
      `This log has been tampered with. The chain breaks at entry ` +
      `${String(result.brokenAt ?? 0)}` +
      (result.reason ? `: ${result.reason}` : "") +
      `.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Machine                                                                     */
/* -------------------------------------------------------------------------- */

export interface MachineState {
  readonly state: "running" | "standby" | "stopped" | "destroyed";
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly tasksServed: number;
}

export interface MachinePanel {
  readonly status: string;
  readonly ageDays: number;
  readonly tasksServed: number;
  /** Plain-language warning shown beside the destroy control. */
  readonly destroyWarning: string;
}

const DAY_MS = 86_400_000;

/**
 * Describe the user's machine.
 *
 * The age is the point. It is not a statistic — it is the accrued trust that
 * makes sites stop challenging this browser, and it is the thing destroying the
 * machine actually costs. A destroy button that says "are you sure?" without
 * saying what is lost is not informed consent.
 */
export function machinePanel(machine: MachineState, now: number): MachinePanel {
  const ageDays = Math.floor((now - machine.createdAt) / DAY_MS);

  const status =
    machine.state === "running"
      ? "Awake"
      : machine.state === "standby"
        ? "Asleep — wakes when you ask for something"
        : machine.state === "stopped"
          ? "Stopped"
          : "Destroyed";

  const age =
    ageDays === 0 ? "set up today" : ageDays === 1 ? "1 day old" : `${String(ageDays)} days old`;

  return {
    status,
    ageDays,
    tasksServed: machine.tasksServed,
    destroyWarning:
      `Your computer is ${age} and has done ${String(machine.tasksServed)} ` +
      `${machine.tasksServed === 1 ? "task" : "tasks"}. Destroying it signs you out of ` +
      `everything it was signed into and discards the history that keeps sites from ` +
      `challenging it. This cannot be undone.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                       */
/* -------------------------------------------------------------------------- */

export type TaskState = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";

export interface TaskSummary {
  readonly id: string;
  readonly label: string;
  readonly state: TaskState;
  readonly updatedAt: number;
  /** Why it is blocked. Present only when it is. */
  readonly blockedOn?: string;
  readonly liveViewUrl?: string;
  readonly replayUrl?: string;
}

export interface TaskGroups {
  /** Waiting on the user. First, because nothing moves until they act. */
  readonly needsYou: readonly TaskSummary[];
  readonly active: readonly TaskSummary[];
  readonly finished: readonly TaskSummary[];
}

/**
 * Group tasks the way a person triages them.
 *
 * Blocked first, and blocked deliberately kept distinct from failed: a task
 * waiting for a CAPTCHA has not gone wrong, and filing it with the failures
 * trains people to ignore the list that most needs them.
 */
export function groupTasks(tasks: readonly TaskSummary[]): TaskGroups {
  const byRecency = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    needsYou: byRecency.filter((task) => task.state === "blocked"),
    active: byRecency.filter((task) => task.state === "running" || task.state === "queued"),
    finished: byRecency.filter(
      (task) => task.state === "done" || task.state === "failed" || task.state === "cancelled"
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

export interface MemoryEntryState {
  readonly id: string;
  readonly text: string;
  readonly importance: number;
  readonly learnedAt: number;
  /** How it was learned. Only user-authored and outcome-derived may exist. */
  readonly lineage: "stated" | "observed";
}

export interface MemoryRow {
  readonly id: string;
  readonly text: string;
  readonly importance: number;
  readonly learnedAt: number;
  /** Plain-language provenance, so "why does it know that" has an answer. */
  readonly because: string;
  readonly deletable: boolean;
}

/**
 * Build a memory row.
 *
 * Everything is deletable, without exception. "Revoke did not delete" is the
 * specific failure that cost the incumbent its trust, and a memory the user
 * cannot remove is that failure with better branding.
 */
export function memoryRow(entry: MemoryEntryState): MemoryRow {
  return {
    id: entry.id,
    text: entry.text,
    importance: entry.importance,
    learnedAt: entry.learnedAt,
    because: entry.lineage === "stated" ? "You told me this." : "I noticed this from a task.",
    deletable: true,
  };
}
