/**
 * The dashboard's window onto the core.
 *
 * Every read goes through here so there is exactly one place where the boundary
 * lives. The rule this file exists to keep: **the dashboard renders decisions,
 * it does not make them.** An approval is checked by the spend gate in the core;
 * a chain is committed by the audit writer in the core; a secret is decrypted by
 * the vault in the core and never travels. Re-deciding any of that here would
 * create a second answer, and a second answer drifts.
 *
 * Until the core exposes these over HTTP, the shapes are served from a fixture
 * so the pages are real and reviewable. The types are the ones the packages
 * already export, so wiring the fetch in later is a change to this file alone —
 * nothing downstream is written against a shape that does not exist yet.
 */

import { appendEntry, type AuditEntry } from "@nell/audit";
import type { PurchasePayload } from "@nell/aegis";
import type {
  MachineState,
  MemoryEntryState,
  StoredKey,
  TaskSummary,
  VaultItemState,
} from "@nell/views";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Stable so a page renders the same thing twice; the real clock arrives with the API. */
const NOW = Date.UTC(2026, 7, 29, 9, 0, 0);

export function now(): number {
  return NOW;
}

export function tasks(): readonly TaskSummary[] {
  return [
    {
      id: "t-1",
      label: "Renew passport",
      state: "blocked",
      updatedAt: NOW - 4 * 60_000,
      blockedOn: "Waiting for you to clear a CAPTCHA",
      liveViewUrl: "https://live.example/t-1",
    },
    {
      id: "t-2",
      label: "Dinner at Rossi, Friday",
      state: "running",
      updatedAt: NOW - 40_000,
      liveViewUrl: "https://live.example/t-2",
    },
    { id: "t-3", label: "Track parcel", state: "queued", updatedAt: NOW - 9 * 60_000 },
    {
      id: "t-4",
      label: "Cancel gym membership",
      state: "done",
      updatedAt: NOW - 20 * HOUR,
      replayUrl: "https://replay.example/t-4.mp4",
    },
    {
      id: "t-5",
      label: "Rebook BA117",
      state: "failed",
      updatedAt: NOW - 2 * DAY,
      replayUrl: "https://replay.example/t-5.mp4",
    },
  ];
}

export interface PendingApproval {
  readonly taskId: string;
  readonly taskLabel: string;
  readonly requestedAt: number;
  readonly payload: PurchasePayload;
}

export function pendingApprovals(): readonly PendingApproval[] {
  return [
    {
      taskId: "t-2",
      taskLabel: "Dinner at Rossi, Friday",
      requestedAt: NOW - 90_000,
      payload: {
        merchant: "Rossi",
        items: [{ description: "Table for two, 20:00", quantity: 1, unitAmount: 0 }],
        options: { date: "2026-09-04", cancellation: "Free until 24h before" },
        totalAmount: 0,
        currency: "GBP",
      },
    },
    {
      taskId: "t-6",
      taskLabel: "Tickets, Barbican",
      requestedAt: NOW - 6 * 60_000,
      payload: {
        merchant: "Barbican",
        items: [{ description: "Stalls, row H", quantity: 2, unitAmount: 4500 }],
        options: { date: "2026-10-11", time: "19:30" },
        totalAmount: 9650,
        currency: "GBP",
      },
    },
  ];
}

export function machine(): MachineState {
  return {
    state: "standby",
    createdAt: NOW - 47 * DAY,
    lastUsedAt: NOW - 12 * 60_000,
    tasksServed: 63,
  };
}

export function vaultItems(): readonly VaultItemState[] {
  return [
    {
      id: "v-1",
      kind: "login",
      label: "British Airways",
      origins: ["https://ba.example"],
      updatedAt: NOW - 30 * DAY,
      lastUsedAt: NOW - 2 * DAY,
    },
    {
      id: "v-2",
      kind: "payment",
      label: "Visa ending 4242",
      origins: ["https://barbican.example", "https://rossi.example"],
      updatedAt: NOW - 60 * DAY,
    },
    {
      id: "v-3",
      kind: "address",
      label: "Home",
      origins: ["https://shop.example"],
      updatedAt: NOW - 90 * DAY,
    },
    // No origins: can never be filled, and the vault page has to say so.
    { id: "v-4", kind: "login", label: "Gym portal", origins: [], updatedAt: NOW - 5 * DAY },
  ];
}

export function memories(): readonly MemoryEntryState[] {
  return [
    {
      id: "m-1",
      text: "Aisle seat, never the back row",
      importance: 8,
      learnedAt: NOW - 40 * DAY,
      lineage: "stated",
    },
    {
      id: "m-2",
      text: "Dislikes early flights before 09:00",
      importance: 7,
      learnedAt: NOW - 22 * DAY,
      lineage: "stated",
    },
    {
      id: "m-3",
      text: "Books Rossi roughly monthly, usually Friday",
      importance: 5,
      learnedAt: NOW - 9 * DAY,
      lineage: "observed",
    },
    {
      id: "m-4",
      text: "Uses the Visa ending 4242 for tickets",
      importance: 4,
      learnedAt: NOW - 3 * DAY,
      lineage: "observed",
    },
  ];
}

export function auditEntries(): readonly AuditEntry[] {
  const written: AuditEntry[] = [];
  let previous: AuditEntry | undefined;

  const events = [
    ["approval.mint", "Barbican", NOW - 6 * 60_000],
    ["vault.fill", "v-1", NOW - 2 * DAY],
    ["policy.deny", "session-9", NOW - 2 * DAY + 4000],
    ["purchase.execute", "Barbican", NOW - 30 * DAY],
    ["memory.write", "m-3", NOW - 9 * DAY],
  ] as const;

  for (const [action, subject, at] of events) {
    previous = appendEntry(previous, {
      workspaceId: "ws-1",
      action,
      subject,
      at: new Date(at).toISOString(),
    });
    written.push(previous);
  }

  return written;
}

export function storedKeys(): readonly StoredKey[] {
  return [{ provider: "anthropic", hint: "…8f2c", addedAt: NOW - 12 * DAY }];
}

export function selectedModels(): Readonly<Record<"nano" | "worker" | "frontier", string>> {
  return {
    nano: "anthropic/claude-haiku-4-5",
    worker: "anthropic/claude-sonnet-5",
    frontier: "anthropic/claude-opus-5",
  };
}

/** Relative time, for a UI where "4 minutes ago" beats a timestamp. */
export function ago(at: number, reference: number = NOW): string {
  const seconds = Math.max(0, Math.round((reference - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${String(days)} days ago`;
}
