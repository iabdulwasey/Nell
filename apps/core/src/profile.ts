/**
 * What Nell knows about the person it works for.
 *
 * Tier-1 memory, finally given a database. `writePreference` and `renderProfile`
 * have been built and tested since v1 over plain arrays; nothing ever stored one,
 * so every task started knowing nothing about the user. Watched live, that looked
 * like: "find me the best Spider-Man shows **near me**", and an agent searching
 * the phrase "near me" literally, because it had no idea where that was.
 *
 * Instinct does not solve this with clever geolocation — the browser runs in a
 * datacenter, so asking it would give a confidently wrong answer. It solves it
 * by having asked once, at onboarding, and never forgetting. That is the whole
 * mechanism, and it is why the profile is worth more than any single feature
 * built on top of it.
 *
 * **The write guarantee stays where it was tested.** Rather than reimplement
 * "untrusted content can never write a preference" in SQL, this reads the live
 * rows, runs the pure function, and persists what it returns. A page that says
 * "the user lives in Berlin" therefore cannot become a fact about the user, and
 * the reason it cannot is one function with its own tests rather than a
 * condition duplicated here and drifting.
 */

import {
  DEFAULT_IMPORTANCE,
  renderProfile,
  writePreference,
  type Preference,
  type PreferenceCategory,
} from "@nell/memory";
import type { AccessScope, Provenance } from "@nell/shared";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/** Where the user is. One key, because "near me" has one answer. */
export const LOCATION_KEY = "location.home";

/**
 * Location outranks nearly everything when the profile is trimmed to fit.
 *
 * Not a preference in the ordinary sense — it is the difference between a task
 * that can start and one that cannot. Dropping it to make room for a favourite
 * airline would be an odd trade.
 */
const IMPORTANCE: Readonly<Record<string, number>> = { [LOCATION_KEY]: 9 };

interface Row {
  id: string;
  key: string;
  value: string;
  category: string;
  provenance: string;
  observed_at: Date;
}

function toPreference(row: Row, workspaceId: string): Preference {
  return {
    id: row.id,
    workspaceId,
    key: row.key,
    value: row.value,
    category: row.category as PreferenceCategory,
    provenance: row.provenance as Provenance,
    observedAt: row.observed_at.getTime(),
    importance: IMPORTANCE[row.key] ?? DEFAULT_IMPORTANCE,
  };
}

export async function readProfile(
  client: PoolClient,
  scope: AccessScope
): Promise<readonly Preference[]> {
  const { rows } = await client.query<Row>(
    `SELECT id, key, value, category, provenance, observed_at
       FROM preferences
      WHERE workspace_id = $1 AND superseded_by IS NULL
      ORDER BY observed_at DESC`,
    [scope.workspaceId]
  );
  return rows.map((row) => toPreference(row, scope.workspaceId));
}

/**
 * Remove one fact, by row.
 *
 * Deleted rather than superseded, because this is the user striking a line out
 * of their own memory file rather than the system learning something newer. A
 * tombstone would keep the fact readable in the very document they just removed
 * it from.
 */
export async function forgetPreferenceRow(
  client: PoolClient,
  scope: AccessScope,
  id: string
): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM preferences WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, id]
  );
  return (rowCount ?? 0) > 0;
}

export async function remember(
  client: PoolClient,
  scope: AccessScope,
  input: {
    readonly key: string;
    readonly value: string;
    readonly category: PreferenceCategory;
    readonly provenance: Provenance;
  }
): Promise<boolean> {
  const existing = await readProfile(client, scope);

  const result = writePreference({
    existing,
    id: randomUUID(),
    workspaceId: scope.workspaceId,
    key: input.key,
    value: input.value,
    category: input.category,
    provenance: input.provenance,
    importance: IMPORTANCE[input.key] ?? DEFAULT_IMPORTANCE,
    now: Date.now(),
  });

  // Refused — untrusted provenance, empty, or too long. The reason is the pure
  // function's to decide and it has already decided.
  if (!result.ok) return false;

  /**
   * One live row per key, because the table says so.
   *
   * The in-memory model supersedes by keeping the old row and stamping it; the
   * table has a unique index on (workspace_id, key), so here supersession is
   * the update. Worth naming rather than silently reconciling: the two are not
   * the same shape, and the database's is the one that has to hold.
   */
  await client.query(
    `INSERT INTO preferences (id, workspace_id, key, value, category, provenance, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (workspace_id, key)
     DO UPDATE SET value = EXCLUDED.value,
                   category = EXCLUDED.category,
                   provenance = EXCLUDED.provenance,
                   observed_at = now()`,
    [randomUUID(), scope.workspaceId, input.key, input.value, input.category, input.provenance]
  );

  return true;
}

export async function locationOf(
  client: PoolClient,
  scope: AccessScope
): Promise<string | undefined> {
  const profile = await readProfile(client, scope);
  return profile.find((preference) => preference.key === LOCATION_KEY)?.value;
}

/** Forget everything. The plan's rule is that every memory is deletable, no exceptions. */
export async function forgetProfile(client: PoolClient, scope: AccessScope): Promise<number> {
  const { rowCount } = await client.query(`DELETE FROM preferences WHERE workspace_id = $1`, [
    scope.workspaceId,
  ]);
  return rowCount ?? 0;
}

/**
 * Does this task need to know where the user is?
 *
 * Deterministic, because it decides whether to interrupt someone with a
 * question and a model call to answer "does 'near me' mean nearby" would be an
 * odd expense. These phrases mean one thing.
 */
const NEEDS_LOCATION =
  /\b(near ?by|near me|around me|close to me|in my area|my city|my area|nearest|local(?:ly)?|around here|near here|where i (?:am|live))\b/iu;

export function needsLocation(objective: string): boolean {
  return NEEDS_LOCATION.test(objective);
}

/**
 * The profile as the planner sees it.
 *
 * Empty string when there is nothing worth saying, so the caller can drop the
 * section entirely rather than sending a heading over nothing.
 */
export function profileForPrompt(profile: readonly Preference[], scope: AccessScope): string {
  if (profile.length === 0) return "";
  return renderProfile(profile, scope.workspaceId);
}
