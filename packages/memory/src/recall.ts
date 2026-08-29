/**
 * Tier 4 — the recall index.
 *
 * Everything above this is authored: preferences the user stated, outcomes a
 * task recorded, playbooks a human reviewed. This tier is *derived*. It exists
 * only to answer "what do I know that bears on this?" quickly, and every entry
 * in it can be reconstructed from a row that lives somewhere else.
 *
 * That derivation is not an implementation detail — it is the entire reason this
 * design is safe to build. The incumbent's worst moment was a user disconnecting
 * their mailbox and finding their mail still sitting in a searchable corpus
 * weeks later, because a derived index had quietly become a second source of
 * truth that nobody could account for. Here, an index entry that cannot name a
 * live source is not merely stale — it is *invalid*, and rebuilding removes it.
 *
 * So deletion is provable rather than promised: delete the source, rebuild, and
 * the derived copy is gone by construction. There is no sweep to remember, no
 * cascade to get right, and no way for an entry to outlive what it came from.
 *
 * Ranking is lexical here and takes an embedding through a port. That ordering
 * is deliberate: an exact term match on "BA117" is what a person actually meant,
 * and a purely semantic index will happily return three thematically-adjacent
 * flights instead. Semantic similarity earns its place on the vaguer half of
 * queries, not the whole of them.
 */

import { z } from "zod";

/** Where an entry came from. An entry with no live source does not survive a rebuild. */
export const sourceKindSchema = z.enum(["preference", "ledger", "directive", "playbook"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export interface SourceRecord {
  readonly kind: SourceKind;
  readonly id: string;
  readonly text: string;
  /** When the underlying fact was learned, not when it was indexed. */
  readonly at: number;
  /** 1–10, carried through from the source so ranking can respect it. */
  readonly importance?: number;
}

export interface IndexEntry {
  readonly sourceKind: SourceKind;
  readonly sourceId: string;
  readonly text: string;
  readonly at: number;
  readonly importance: number;
  /** Lowercased terms, kept so scoring does not re-tokenise on every query. */
  readonly terms: readonly string[];
  /** Optional embedding, when a provider is configured. */
  readonly embedding?: readonly number[];
}

/**
 * Words that carry no signal. Kept short on purpose: an aggressive stop list
 * throws away "no" and "not", and a preference of "no early flights" indexed
 * without its negation means the opposite of what the user said.
 */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "it",
  "this",
  "that",
  "my",
  "me",
  "i",
]);

/**
 * Reduce a word to a crude stem.
 *
 * Deliberately conservative — four suffixes and a minimum length, not a real
 * stemmer. The reason it exists at all: without it, "did I book a flight" fails
 * to match a record that says "Booked BA117", and a memory system that cannot
 * connect those two is not doing the one job it has. Aggressive stemming trades
 * that miss for a worse one, collapsing distinct words into a shared stem, so
 * this stops well short.
 *
 * Codes and identifiers are left alone: "BA117" must not become "BA11".
 */
export function stem(token: string): string {
  if (token.length <= 4 || /\d/u.test(token)) return token;

  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (!token.endsWith(suffix)) continue;
    const cut = token.slice(0, -suffix.length);
    if (cut.length < 3) continue;

    // "cancelled" -> "cancell" -> "cancel". Without this, the past tense and the
    // present tense of the same word land in different buckets.
    return /([^aeiou])\1$/u.test(cut) ? cut.slice(0, -1) : cut;
  }

  return token;
}

export function tokenize(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem);
}

export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/**
 * Build the index from sources.
 *
 * A pure function of its input. Rebuilding after a source is removed cannot
 * leave a trace of it, because nothing is carried over from the previous index —
 * an incremental updater is exactly where "revoke did not delete" comes from.
 */
export async function buildIndex(
  sources: readonly SourceRecord[],
  embeddings?: EmbeddingProvider
): Promise<readonly IndexEntry[]> {
  const entries = sources.map((source) => ({
    sourceKind: source.kind,
    sourceId: source.id,
    text: source.text,
    at: source.at,
    importance: source.importance ?? 5,
    terms: tokenize(source.text),
  }));

  if (!embeddings || entries.length === 0) return entries;

  try {
    const vectors = await embeddings.embed(entries.map((entry) => entry.text));
    return entries.map((entry, index) => ({ ...entry, embedding: vectors[index] }));
  } catch {
    // A provider outage degrades recall to lexical rather than losing the index.
    // Recall that is worse is survivable; recall that is absent is not.
    return entries;
  }
}

/** Half-life for recency, in days. Recent things matter more, old things still count. */
export const RECENCY_HALF_LIFE_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * How much a memory's age discounts it.
 *
 * Exponential decay rather than a cutoff. A cutoff means a preference stated 91
 * days ago vanishes entirely, which is not how knowing someone works — "aisle
 * seat" does not stop being true because a quarter passed.
 */
export function recencyWeight(at: number, now: number): number {
  const ageDays = Math.max(0, (now - at) / DAY_MS);
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

export interface RecallOptions {
  readonly now: number;
  readonly limit?: number;
  /** Query embedding, when the caller has one. */
  readonly queryEmbedding?: readonly number[];
  /**
   * How much semantic similarity counts against exact term matching. Low by
   * default: an exact match on "BA117" is what the person meant, and a semantic
   * index will cheerfully return three adjacent flights instead.
   */
  readonly semanticWeight?: number;
}

export interface MemoryHit {
  readonly entry: IndexEntry;
  readonly score: number;
  /** Which query terms actually matched, so a UI can say why this surfaced. */
  readonly matched: readonly string[];
}

export const DEFAULT_RECALL_LIMIT = 8;

/**
 * Find what bears on a query.
 *
 * Scoring is term overlap, weighted by how rare a term is across the index, then
 * scaled by recency and importance. Rarity matters: "flight" appearing in forty
 * entries tells you almost nothing, while "BA117" appearing in one is the whole
 * answer.
 */
export function searchMemory(
  index: readonly IndexEntry[],
  query: string,
  options: RecallOptions
): readonly MemoryHit[] {
  if (index.length === 0) return [];

  const queryTerms = tokenize(query);
  const semanticWeight = options.semanticWeight ?? 0.3;
  const hasSemantic = options.queryEmbedding !== undefined;
  if (queryTerms.length === 0 && !hasSemantic) return [];

  const documentFrequency = new Map<string, number>();
  for (const entry of index) {
    for (const term of new Set(entry.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const scored = index.map((entry): MemoryHit => {
    const entryTerms = new Set(entry.terms);
    const matched = queryTerms.filter((term) => entryTerms.has(term));

    const lexical = matched.reduce((sum, term) => {
      const rarity = Math.log(1 + index.length / (documentFrequency.get(term) ?? 1));
      return sum + rarity;
    }, 0);

    const semantic =
      options.queryEmbedding && entry.embedding
        ? cosineSimilarity(options.queryEmbedding, entry.embedding)
        : 0;

    const relevance = lexical + semantic * semanticWeight * queryTermsFloor(queryTerms.length);
    const weighted =
      relevance * recencyWeight(entry.at, options.now) * (0.5 + entry.importance / 20);

    return { entry, score: weighted, matched };
  });

  return scored
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? DEFAULT_RECALL_LIMIT);
}

/**
 * Keeps semantic similarity from dominating a one-word query.
 *
 * Without it a query with a single rare term scores about 2 lexically, while
 * cosine similarity is near 1 for anything vaguely related — so a fuzzy match
 * outranks the exact one, which is the failure people mean when they say
 * semantic search "feels random".
 */
function queryTermsFloor(count: number): number {
  return Math.max(1, count);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

/**
 * Entries whose source no longer exists.
 *
 * The honesty check. Run after any deletion, and in a periodic sweep, so a
 * derived copy can never quietly outlive the thing it was derived from.
 */
export function orphaned(
  index: readonly IndexEntry[],
  liveSources: readonly SourceRecord[]
): readonly IndexEntry[] {
  const live = new Set(liveSources.map((source) => `${source.kind}:${source.id}`));
  return index.filter((entry) => !live.has(`${entry.sourceKind}:${entry.sourceId}`));
}

export interface RebuildReceipt {
  readonly rebuiltAt: number;
  readonly entriesBefore: number;
  readonly entriesAfter: number;
  /** Sources whose derived entries are gone. Named so a receipt can be shown. */
  readonly removedSources: readonly string[];
}

/**
 * Rebuild, and report what stopped existing.
 *
 * The receipt is the point. "We deleted it" is a claim; "these seventeen derived
 * entries, from these three sources, are gone, and here is the index before and
 * after" is something a user can check.
 */
export async function rebuildIndex(
  previous: readonly IndexEntry[],
  liveSources: readonly SourceRecord[],
  now: number,
  embeddings?: EmbeddingProvider
): Promise<{ readonly index: readonly IndexEntry[]; readonly receipt: RebuildReceipt }> {
  const index = await buildIndex(liveSources, embeddings);
  const live = new Set(liveSources.map((source) => `${source.kind}:${source.id}`));

  const removedSources = [
    ...new Set(
      previous
        .map((entry) => `${entry.sourceKind}:${entry.sourceId}`)
        .filter((key) => !live.has(key))
    ),
  ];

  return {
    index,
    receipt: {
      rebuiltAt: now,
      entriesBefore: previous.length,
      entriesAfter: index.length,
      removedSources,
    },
  };
}

/**
 * Render recalled memories for a prompt.
 *
 * Says where each came from. A model told "you know this because they said so"
 * behaves differently from one told "you inferred this", and a user asking why
 * the agent believes something deserves an answer that is not a guess.
 */
export function renderRecalled(results: readonly MemoryHit[]): string {
  if (results.length === 0) return "";

  const lines = results.map((result) => {
    const origin =
      result.entry.sourceKind === "preference"
        ? "they told me"
        : result.entry.sourceKind === "directive"
          ? "they asked me to"
          : result.entry.sourceKind === "playbook"
            ? "reviewed playbook"
            : "from a past task";
    return `- ${result.entry.text} (${origin})`;
  });

  return `What I know that bears on this:\n${lines.join("\n")}`;
}
