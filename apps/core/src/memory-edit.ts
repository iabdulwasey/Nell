/**
 * Editing what Nell believes about you, and having it stick.
 *
 * `parseMemoryMarkdown` has existed since v1 with nothing calling it, so
 * `MEMORY.md` could be read and never corrected. That is half the point of
 * keeping memory as files: a memory you can only read is one you have to trust,
 * while a memory you can edit is one you can check. The renderer and the parser
 * were both written; only the loop between them was missing.
 *
 * **Every fact written back is `user` provenance, and that is not a shortcut.**
 * A person typing into this box *is* the user speaking — the strongest lineage
 * there is. It is also why editing happens here rather than through anything the
 * agent can reach: a path that let a model rewrite memory after reading a web
 * page would be persistent injection, and no amount of validation downstream
 * would fix having offered it.
 *
 * Unparseable lines are skipped rather than failing the save. Somebody
 * hand-editing a document will not match the format exactly, and losing their
 * other corrections over one malformed line would be hostile — but the count is
 * reported, so a line that silently did nothing is visible rather than assumed.
 */

import { parseMemoryMarkdown, preferenceCategorySchema } from "@nell/memory";
import type { AccessScope } from "@nell/shared";
import type { Pool } from "pg";
import { withWorkspace } from "./db.js";
import { forgetPreferenceRow, readProfile, remember } from "./profile.js";

/** How many facts one edit may write, so a paste cannot fill the table. */
const MAX_FACTS = 200;

export async function applyMemoryEdits(
  pool: Pool,
  scope: AccessScope,
  markdown: string
): Promise<string> {
  const parsed = parseMemoryMarkdown(markdown).slice(0, MAX_FACTS);
  const lines = markdown.split("\n").filter((line) => line.trim().startsWith("- ")).length;
  const skipped = Math.max(0, lines - parsed.length);

  return withWorkspace(pool, scope, async (client) => {
    const before = await readProfile(client, scope);
    const kept = new Set<string>();
    let written = 0;

    for (const fact of parsed) {
      const category = categoryOf(fact.key);
      kept.add(fact.key);

      // Unchanged facts are left alone rather than rewritten, so an edit that
      // touched one line does not restamp the observation time of every other.
      const existing = before.find((preference) => preference.key === fact.key);
      if (existing?.value === fact.value) continue;

      const ok = await remember(client, scope, {
        key: fact.key,
        value: fact.value,
        category,
        // The person typed it. There is no stronger lineage, and nothing else
        // can reach this path.
        provenance: "user",
      });
      if (ok) written += 1;
    }

    /**
     * A line deleted from the document is a fact forgotten.
     *
     * The alternative — treating the edit as additive — would make the file
     * impossible to correct downwards: you could fix a wrong fact but never
     * remove one, which is the more common thing people actually want.
     */
    let forgotten = 0;
    for (const preference of before) {
      if (kept.has(preference.key)) continue;
      if (await forgetPreferenceRow(client, scope, preference.id)) forgotten += 1;
    }

    return describe(written, forgotten, skipped);
  });
}

/**
 * A key like `travel.airline` names its own category.
 *
 * Falling back to `other` rather than refusing: a person inventing a key is
 * doing exactly what free-form memory is for, and rejecting it because the
 * prefix is not in an enum would be the enumeration mistake again.
 */
function categoryOf(key: string): "other" | ReturnType<typeof preferenceCategorySchema.parse> {
  const prefix = key.includes(".") ? key.split(".")[0] : key;
  const parsed = preferenceCategorySchema.safeParse(prefix);
  return parsed.success ? parsed.data : "other";
}

function describe(written: number, forgotten: number, skipped: number): string {
  const parts: string[] = [];
  if (written > 0) parts.push(`${String(written)} updated`);
  if (forgotten > 0) parts.push(`${String(forgotten)} forgotten`);
  if (parts.length === 0) parts.push("nothing changed");

  // Reported rather than swallowed: a line that did nothing should say so, or
  // the person believes they corrected something they did not.
  const note =
    skipped > 0
      ? ` ${String(skipped)} line${skipped === 1 ? "" : "s"} could not be read and ${
          skipped === 1 ? "was" : "were"
        } left alone.`
      : "";

  return `Saved — ${parts.join(", ")}.${note} You can close this tab.`;
}
