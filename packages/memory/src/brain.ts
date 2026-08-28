/**
 * The brain document.
 *
 * Memory is *stored* as rows — that is what gives us transactions, row-level
 * isolation, per-tenant encryption, and honest deletion. But rows are a poor
 * thing to hand a language model, and a worse thing to show a person.
 *
 * So the same memory is *rendered* as a markdown document. This gets both
 * benefits that file-based agents (MEMORY.md / USER.md) enjoy without adopting
 * their weaknesses:
 *
 * - the model reads well-formatted prose rather than a serialized table
 * - the user can read exactly what the agent believes about them, and correct
 *   it — transparency is the entire point of this product
 *
 * Rendering is cached and invalidated by a version stamp, so the hot path costs
 * nothing. (Retrieval was never the bottleneck: it is under 1% of a turn against
 * inference time. The document exists for accuracy and trust, not speed.)
 */

import type { LedgerEntry } from "./ledger.js";
import { renderPrecedents } from "./ledger.js";
import type { Preference } from "./preferences.js";
import { liveProfile } from "./preferences.js";

export interface BrainDocument {
  readonly workspaceId: string;
  readonly markdown: string;
  /** Changes whenever the underlying memory changes; used for cache validity. */
  readonly version: string;
  readonly renderedAt: number;
}

/**
 * Version stamp for a workspace's memory.
 *
 * Derived from what actually affects the document: the number of live
 * preferences and the newest observation time. Cheap to compute, and it changes
 * exactly when the rendered output would.
 */
export function memoryVersion(
  preferences: readonly Preference[],
  entries: readonly LedgerEntry[],
  workspaceId: string
): string {
  const live = liveProfile(preferences, workspaceId);
  const newestPreference = live.reduce((max, p) => Math.max(max, p.observedAt), 0);
  const mine = entries.filter((entry) => entry.workspaceId === workspaceId);
  const newestEntry = mine.reduce((max, e) => Math.max(max, e.completedAt), 0);
  return `${String(live.length)}.${String(newestPreference)}-${String(mine.length)}.${String(newestEntry)}`;
}

export interface RenderBrainOptions {
  readonly workspaceId: string;
  readonly preferences: readonly Preference[];
  readonly entries: readonly LedgerEntry[];
  readonly now: number;
  /** Recent tasks to include. Kept small; this is context, not an archive. */
  readonly recentTaskLimit?: number;
}

/**
 * Render the document.
 *
 * Grouped by category so related facts sit together, which reads better to both
 * a model and a person than a flat list.
 */
export function renderBrain(options: RenderBrainOptions): BrainDocument {
  const live = liveProfile(options.preferences, options.workspaceId);
  const sections: string[] = [];

  if (live.length > 0) {
    const byCategory = new Map<string, Preference[]>();
    for (const preference of live) {
      const bucket = byCategory.get(preference.category) ?? [];
      bucket.push(preference);
      byCategory.set(preference.category, bucket);
    }

    const parts = [...byCategory.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([category, items]) => {
        const lines = items.map((item) => `- ${humanizeKey(item.key)}: ${item.value}`).join("\n");
        return `### ${titleCase(category)}\n${lines}`;
      });

    sections.push(`## What I know about you\n\n${parts.join("\n\n")}`);
  }

  const recent = options.entries
    .filter((entry) => entry.workspaceId === options.workspaceId)
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, options.recentTaskLimit ?? 5);

  if (recent.length > 0) {
    sections.push(`## Recent tasks\n\n${renderPrecedents(recent)}`);
  }

  const markdown =
    sections.length > 0 ? sections.join("\n\n") : "_Nothing remembered yet. I'll learn as we go._";

  return {
    workspaceId: options.workspaceId,
    markdown,
    version: memoryVersion(options.preferences, options.entries, options.workspaceId),
    renderedAt: options.now,
  };
}

/** "travel.home_airport" reads better as "Home airport". */
function humanizeKey(key: string): string {
  const tail = key.includes(".") ? (key.split(".").pop() ?? key) : key;
  const words = tail.replaceAll(/[_-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Cache keyed by workspace, invalidated by version.
 *
 * Deliberately tiny and in-process: the document is cheap to rebuild, so a
 * distributed cache would add a network hop to save a millisecond.
 */
export class BrainCache {
  readonly #entries = new Map<string, BrainDocument>();

  get(workspaceId: string, version: string): BrainDocument | undefined {
    const cached = this.#entries.get(workspaceId);
    return cached && cached.version === version ? cached : undefined;
  }

  set(document: BrainDocument): void {
    this.#entries.set(document.workspaceId, document);
  }

  /** Drop a workspace's cache — used on deletion, not just invalidation. */
  evict(workspaceId: string): void {
    this.#entries.delete(workspaceId);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Render, reusing the cached document when memory has not changed. */
export function renderBrainCached(cache: BrainCache, options: RenderBrainOptions): BrainDocument {
  const version = memoryVersion(options.preferences, options.entries, options.workspaceId);
  const cached = cache.get(options.workspaceId, version);
  if (cached) return cached;

  const document = renderBrain(options);
  cache.set(document);
  return document;
}
