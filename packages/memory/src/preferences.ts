/**
 * Tier 1 — the preference profile.
 *
 * A small, bounded set of durable facts about the user, injected into every
 * coordinator turn: dietary needs, default airport, seat preference, who "the
 * kids" are. This is what makes the agent feel like it knows you rather than
 * interrogating you every time.
 *
 * Two properties matter more than the storage shape:
 *
 * 1. **Contradictions supersede rather than accumulate.** If you say you're
 *    vegetarian and later say you eat fish, the profile must not hold both and
 *    let the model pick. The newer statement wins and the older is retired.
 * 2. **Untrusted content can never write here.** A preference is effectively a
 *    standing instruction, so letting a web page or an email create one would
 *    be prompt injection with persistence. Writes accept only user-authored or
 *    system-derived provenance.
 */

import type { Provenance } from "@nell/shared";
import { z } from "zod";

export const preferenceCategorySchema = z.enum([
  "dietary",
  "travel",
  "payment",
  "communication",
  "schedule",
  "household",
  "shopping",
  "other",
]);

export type PreferenceCategory = z.infer<typeof preferenceCategorySchema>;

export interface Preference {
  readonly id: string;
  readonly workspaceId: string;
  /** Stable slug, e.g. "diet.restrictions" or "travel.home_airport". */
  readonly key: string;
  readonly value: string;
  readonly category: PreferenceCategory;
  readonly provenance: Provenance;
  readonly observedAt: number;
  /** Set when a newer statement replaced this one. */
  readonly supersededAt?: number;
}

export type WriteRejection = "untrusted-provenance" | "empty-value" | "value-too-long";

export type WriteResult =
  | { readonly ok: true; readonly preferences: readonly Preference[]; readonly superseded: number }
  | { readonly ok: false; readonly reason: WriteRejection };

export const MAX_VALUE_LENGTH = 500;

export interface WriteOptions {
  readonly existing: readonly Preference[];
  readonly id: string;
  readonly workspaceId: string;
  readonly key: string;
  readonly value: string;
  readonly category: PreferenceCategory;
  readonly provenance: Provenance;
  readonly now: number;
}

/**
 * Record a preference, retiring any earlier live value for the same key.
 *
 * Returns a rejection rather than throwing so the caller can log the refusal to
 * the audit trail — a blocked memory write is exactly the sort of event worth
 * being able to see later.
 */
export function writePreference(options: WriteOptions): WriteResult {
  // The injection boundary. A page or an email cannot leave a standing
  // instruction behind, no matter how convincing its text is.
  if (options.provenance === "untrusted") {
    return { ok: false, reason: "untrusted-provenance" };
  }

  const value = options.value.trim();
  if (!value) return { ok: false, reason: "empty-value" };
  if (value.length > MAX_VALUE_LENGTH) return { ok: false, reason: "value-too-long" };

  let superseded = 0;
  const preferences = options.existing.map((preference) => {
    const isLiveMatch =
      preference.workspaceId === options.workspaceId &&
      preference.key === options.key &&
      preference.supersededAt === undefined;
    if (!isLiveMatch) return preference;
    superseded += 1;
    return { ...preference, supersededAt: options.now };
  });

  preferences.push({
    id: options.id,
    workspaceId: options.workspaceId,
    key: options.key,
    value,
    category: options.category,
    provenance: options.provenance,
    observedAt: options.now,
  });

  return { ok: true, preferences, superseded };
}

/** The live profile: newest value per key, retired entries excluded. */
export function liveProfile(
  preferences: readonly Preference[],
  workspaceId: string
): readonly Preference[] {
  const byKey = new Map<string, Preference>();
  for (const preference of preferences) {
    if (preference.workspaceId !== workspaceId) continue;
    if (preference.supersededAt !== undefined) continue;
    const existing = byKey.get(preference.key);
    if (!existing || preference.observedAt > existing.observedAt) {
      byKey.set(preference.key, preference);
    }
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Retire a preference without replacing it ("forget that I'm vegetarian"). */
export function forgetPreference(
  preferences: readonly Preference[],
  workspaceId: string,
  key: string,
  now: number
): readonly Preference[] {
  return preferences.map((preference) =>
    preference.workspaceId === workspaceId &&
    preference.key === key &&
    preference.supersededAt === undefined
      ? { ...preference, supersededAt: now }
      : preference
  );
}

/**
 * Render the profile for a prompt.
 *
 * Bounded on purpose: an unbounded profile would grow until it crowded out the
 * actual conversation, and the cost of every turn scales with it.
 */
export function renderProfile(
  preferences: readonly Preference[],
  workspaceId: string,
  maxChars = 2000
): string {
  const live = liveProfile(preferences, workspaceId);
  if (live.length === 0) return "";

  const lines: string[] = [];
  let used = 0;
  for (const preference of live) {
    const line = `- ${preference.key}: ${preference.value}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
