/**
 * Monitors — the proactivity engine.
 *
 * A monitor is a standing intent ("tell me when a Nobu table opens"). A cron
 * heartbeat leases due monitors, runs a cheap deterministic pre-check, and only
 * wakes the agent when something actually changed.
 *
 * Three properties make this affordable and non-annoying:
 *
 * 1. **The pre-check costs nothing.** A price comparison or a page-hash diff is
 *    plain code. Waking a model on every tick of every monitor is what makes
 *    always-on agents ruinously expensive; here a quiet tick costs zero tokens.
 * 2. **Leases prevent double-firing.** Claiming is atomic, so two workers cannot
 *    act on the same monitor and message the user twice.
 * 3. **Reports are deduplicated.** A monitor that finds the same thing twice
 *    stays silent. Repeating yourself is how a proactive agent becomes noise.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const checkTypeSchema = z.enum([
  "price-below",
  "availability-appeared",
  "page-changed",
  "inbox-matches",
]);

export type CheckType = z.infer<typeof checkTypeSchema>;

export interface Monitor {
  readonly id: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly checkType: CheckType;
  readonly checkConfig: Readonly<Record<string, string | number>>;
  /** Dispatched only when the pre-check reports a change. */
  readonly prompt: string;
  readonly everyMinutes: number;
  readonly nextRunAt: number;
  readonly leaseExpiresAt?: number;
  readonly enabled: boolean;
}

export const MAX_CLAIMS_PER_TICK = 25;
export const LEASE_MS = 5 * 60 * 1000;

/**
 * Select due monitors and mark them leased.
 *
 * Mirrors `SELECT ... FOR UPDATE SKIP LOCKED` so the pure logic can be tested
 * without a database; the SQL is what makes it atomic in production.
 */
export function claimDue(
  monitors: readonly Monitor[],
  now: number,
  limit: number = MAX_CLAIMS_PER_TICK
): { readonly claimed: readonly Monitor[]; readonly monitors: readonly Monitor[] } {
  const claimedIds = new Set<string>();

  const due = monitors
    .filter(
      (monitor) =>
        monitor.enabled &&
        monitor.nextRunAt <= now &&
        // A live lease means someone else already has it.
        (monitor.leaseExpiresAt === undefined || monitor.leaseExpiresAt <= now)
    )
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
    .slice(0, limit);

  for (const monitor of due) claimedIds.add(monitor.id);

  const updated = monitors.map((monitor) =>
    claimedIds.has(monitor.id) ? { ...monitor, leaseExpiresAt: now + LEASE_MS } : monitor
  );

  return {
    claimed: due.map((monitor) => ({ ...monitor, leaseExpiresAt: now + LEASE_MS })),
    monitors: updated,
  };
}

/** Release a monitor after a run, scheduling its next tick. */
export function completeRun(
  monitors: readonly Monitor[],
  monitorId: string,
  now: number
): readonly Monitor[] {
  return monitors.map((monitor) =>
    monitor.id === monitorId
      ? {
          ...monitor,
          leaseExpiresAt: undefined,
          nextRunAt: now + monitor.everyMinutes * 60 * 1000,
        }
      : monitor
  );
}

/** What a pre-check observed. */
export interface Observation {
  readonly changed: boolean;
  /** Stable digest of the finding, used to suppress repeats. */
  readonly digest: string;
  /** Human-readable summary, only meaningful when changed. */
  readonly summary?: string;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

/**
 * Deterministic pre-checks. Plain functions, no model involved — this is the
 * cost firewall that makes always-on monitoring viable.
 */
export const preChecks: Readonly<
  Record<CheckType, (config: Record<string, string | number>, sample: unknown) => Observation>
> = {
  "price-below": (config, sample) => {
    const threshold = Number(config.threshold ?? 0);
    const price = Number(sample);
    const changed = Number.isFinite(price) && price <= threshold;
    return {
      changed,
      digest: digestOf(["price", price]),
      summary: changed ? `Price is ${String(price)}, at or below ${String(threshold)}.` : undefined,
    };
  },

  "availability-appeared": (_config, sample) => {
    const available = Boolean(sample);
    return {
      changed: available,
      digest: digestOf(["availability", available]),
      summary: available ? "Availability appeared." : undefined,
    };
  },

  "page-changed": (config, sample) => {
    const previous = String(config.previousDigest ?? "");
    const current = digestOf(sample);
    const changed = previous !== "" && previous !== current;
    return {
      changed,
      digest: current,
      summary: changed ? "The page changed." : undefined,
    };
  },

  "inbox-matches": (config, sample) => {
    const needle = String(config.match ?? "").toLowerCase();
    const haystack = String(sample ?? "").toLowerCase();
    const changed = needle !== "" && haystack.includes(needle);
    return {
      changed,
      digest: digestOf(["inbox", haystack.slice(0, 200)]),
      summary: changed ? `Matched "${String(config.match)}".` : undefined,
    };
  },
};

export function runPreCheck(monitor: Monitor, sample: unknown): Observation {
  return preChecks[monitor.checkType]({ ...monitor.checkConfig }, sample);
}

export type FireDecision =
  | { readonly fire: true; readonly summary: string; readonly digest: string }
  | { readonly fire: false; readonly reason: "no-change" | "already-reported" };

/**
 * Decide whether to wake the agent. Silence is a valid, common outcome — a
 * monitor that reports nothing new should say nothing at all.
 */
export function decideFire(
  observation: Observation,
  reportedDigests: readonly string[]
): FireDecision {
  if (!observation.changed) return { fire: false, reason: "no-change" };
  if (reportedDigests.includes(observation.digest)) {
    return { fire: false, reason: "already-reported" };
  }
  return {
    fire: true,
    summary: observation.summary ?? "Something changed.",
    digest: observation.digest,
  };
}
