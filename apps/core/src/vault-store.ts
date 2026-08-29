/**
 * The vault, finally given a database.
 *
 * The crypto has been complete since Phase 0 — AES-256-GCM, a fresh IV per
 * write, AAD binding each ciphertext to `workspace | namespace | item` so a row
 * swapped in the database fails its auth tag rather than yielding someone else's
 * secret, and a key id in the wire format so rotation needs no flag day. Three
 * test files cover it. Nothing has ever stored a secret with it.
 *
 * That absence is the ceiling on what Nell can finish. Every real task — book
 * the table, order the thing, check the bill — reaches a sign-in and stops,
 * because there is no credential to offer.
 *
 * **The shape of this file is the security property.** There is exactly one way
 * a plaintext secret leaves here, `revealForOrigin`, and it will not produce one
 * without being told the origin the browser is *actually* on. Everything else
 * returns metadata: labels, hints, which sites an item is for. A caller that
 * wants a password must already be somewhere, and that somewhere is checked
 * against the item's own allowlist before anything is decrypted.
 *
 * The model never calls any of it. It names an opaque item id and a field; the
 * value is fetched, decrypted and typed on the far side of the chokepoint, and
 * the session is tainted the moment it lands.
 */

import { checkOrigin, explainOriginDenial, normalizeOrigin } from "@nell/aegis";
import type { AccessScope } from "@nell/shared";
import {
  decryptSecret,
  encryptSecret,
  originBound,
  vaultItemKindSchema,
  type KeyProvider,
  type Secret,
} from "@nell/vault";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

/** What the agent and the dashboard may see: everything except the secret. */
export interface VaultItemSummary {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** Non-secret, e.g. "abdul@example.com" or "Visa ending 4242". */
  readonly accountHint?: string;
  /** Origins this item may be filled into. */
  readonly origins: readonly string[];
}

export const NAMESPACE = "vault";

const rowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  account_hint: z.string().nullish(),
  origins: z.array(z.string()).default([]),
});

export interface SaveItemInput {
  readonly kind: string;
  readonly label: string;
  readonly accountHint?: string;
  /** Where it may be used. An item with none can never be filled anywhere. */
  readonly origins: readonly string[];
  /** The secret itself, as JSON — a login is `{username, password}`. */
  readonly value: string;
}

/**
 * Store a secret.
 *
 * Encrypted before it touches the database, bound to this workspace and item, so
 * the row is meaningless anywhere else. The plaintext is never written, never
 * logged, and never returned by anything in this file except the one function
 * that checks an origin first.
 */
export async function saveItem(
  client: PoolClient,
  scope: AccessScope,
  keys: KeyProvider,
  input: SaveItemInput
): Promise<string> {
  const kind = vaultItemKindSchema.safeParse(input.kind);
  if (!kind.success) throw new Error(`Unknown vault item kind: ${input.kind}`);

  /**
   * Normalised on the way in, not compared loosely on the way out.
   *
   * An allowlist of "https://Example.com/login" that fails to match
   * `https://example.com` is a vault that silently never fills, and the fix
   * people reach for when that happens is a looser comparison — which is how
   * an allowlist stops meaning anything.
   */
  const origins = [...new Set(input.origins.map((origin) => normalize(origin)).filter(Boolean))];

  /**
   * Required for a login, and only for a login.
   *
   * The rule lives in `originBound` beside the kinds themselves, so "which items
   * are site-scoped" is answered in one place rather than re-decided at every
   * call site. An address with no origins is a correctly stored address; a login
   * with none is an item that can never be filled anywhere, which is a footgun
   * saved for later.
   */
  if (originBound(kind.data) && origins.length === 0) {
    throw new Error("A saved login needs at least one site, or it can never be used.");
  }

  const id = randomUUID();
  const encrypted = await encryptSecret(
    keys,
    { workspaceId: scope.workspaceId, namespace: NAMESPACE, itemId: id },
    input.value
  );

  await client.query(
    `INSERT INTO vault_items (id, workspace_id, kind, label, account_hint, origins, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())`,
    [
      id,
      scope.workspaceId,
      kind.data,
      input.label.slice(0, 120),
      input.accountHint ?? null,
      JSON.stringify(origins),
    ]
  );

  await client.query(
    `INSERT INTO vault_secrets (workspace_id, namespace, item_id, encrypted_value, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (workspace_id, namespace, item_id)
     DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = now()`,
    [scope.workspaceId, NAMESPACE, id, encrypted]
  );

  return id;
}

/** Everything the agent may know about what is stored. Never a value. */
export async function listItems(
  client: PoolClient,
  scope: AccessScope
): Promise<readonly VaultItemSummary[]> {
  const { rows } = await client.query(
    `SELECT id, kind, label, account_hint, origins FROM vault_items
      WHERE workspace_id = $1 ORDER BY label`,
    [scope.workspaceId]
  );

  return rows
    .map((row) => rowSchema.safeParse(row))
    .filter((parsed) => parsed.success)
    .map(({ data }) => ({
      id: data.id,
      kind: data.kind,
      label: data.label,
      ...(data.account_hint ? { accountHint: data.account_hint } : {}),
      origins: data.origins,
    }));
}

/**
 * Which items claim a given origin — what the agent consults at a login wall.
 *
 * Asked through the same `checkOrigin` that guards the reveal, rather than by
 * comparing strings here. Two places that decide what "matches" is one place
 * too many: the moment they disagree, either the vault offers a credential it
 * will then refuse to hand over, or it hides one it would have.
 */
export async function itemsForOrigin(
  client: PoolClient,
  scope: AccessScope,
  origin: string
): Promise<readonly VaultItemSummary[]> {
  const all = await listItems(client, scope);
  return all.filter((item) => usableAt(item.kind, item.origins, origin).allowed);
}

/**
 * One decision, asked by both the listing and the reveal.
 *
 * Two places deciding what "usable here" means is one too many: the moment they
 * disagree, the vault either offers a credential it will then refuse or hides
 * one it would have handed over. The first wastes a task; the second is worse,
 * because it looks like the vault being empty.
 */
function usableAt(
  kind: string,
  allowlist: readonly string[],
  actualOrigin: string
): { allowed: true } | { allowed: false; reason: string } {
  const parsed = vaultItemKindSchema.safeParse(kind);
  // An unrecognised kind is refused rather than treated as unbound. A row that
  // should not exist must not be the one that skips the check.
  if (!parsed.success) return { allowed: false, reason: "That item is of an unknown kind." };

  if (originBound(parsed.data)) {
    const decision = checkOrigin({ actualOrigin, allowlist });
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, reason: explainOriginDenial(decision.reason) };
  }

  /**
   * Unbound, but not unchecked.
   *
   * An address is usable anywhere; it is still not usable on a page that is not
   * encrypted. `checkOrigin` bundles the scheme rule with the allowlist rule, so
   * the scheme is asked here on its own — against the item's own origin, which
   * always passes an allowlist containing itself.
   */
  const normalized = normalizeOrigin(actualOrigin);
  if (!normalized) return { allowed: false, reason: "The browser reported no readable origin." };

  const decision = checkOrigin({ actualOrigin: normalized, allowlist: [normalized] });
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, reason: explainOriginDenial(decision.reason) };
}

export type RevealOutcome =
  | { readonly ok: true; readonly value: Secret<string> }
  | { readonly ok: false; readonly reason: string };

/**
 * The only way a plaintext secret leaves this module.
 *
 * `actualOrigin` must come from the live browser session, never from the model
 * and never from a caller's belief about where it is — that is the whole point.
 * FreeInstinct let the model supply the expected origin, which makes the
 * allowlist a suggestion: a page that convinces the agent it is the bank gets
 * the bank's password. Read from the session, the check is about where the
 * browser *is*, and no amount of persuasion moves it.
 */
export async function revealForOrigin(
  client: PoolClient,
  scope: AccessScope,
  keys: KeyProvider,
  itemId: string,
  actualOrigin: string
): Promise<RevealOutcome> {
  const { rows } = await client.query(
    `SELECT i.kind, i.origins, s.encrypted_value
       FROM vault_items i
       JOIN vault_secrets s
         ON s.item_id = i.id AND s.workspace_id = i.workspace_id AND s.namespace = $3
      WHERE i.id = $1 AND i.workspace_id = $2`,
    [itemId, scope.workspaceId, NAMESPACE]
  );

  const row = rows[0] as
    | { kind?: string; origins?: string[]; encrypted_value?: string }
    | undefined;
  // Reported as missing rather than forbidden: a caller learns nothing about
  // what exists in another workspace.
  if (!row?.encrypted_value) return { ok: false, reason: "No such vault item." };

  const decision = usableAt(row.kind ?? "", row.origins ?? [], actualOrigin);
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  /**
   * Decrypted last, and only once the origin has passed.
   *
   * Ordering matters more than it looks: decrypting first and checking after
   * puts the plaintext in memory on a path that was about to be refused, and
   * every accident that follows starts there.
   */
  const value = await decryptSecret(
    keys,
    { workspaceId: scope.workspaceId, namespace: NAMESPACE, itemId },
    row.encrypted_value
  );

  return { ok: true, value };
}

export async function forgetItem(
  client: PoolClient,
  scope: AccessScope,
  itemId: string
): Promise<boolean> {
  await client.query(
    `DELETE FROM vault_secrets WHERE workspace_id = $1 AND namespace = $2 AND item_id = $3`,
    [scope.workspaceId, NAMESPACE, itemId]
  );
  const { rowCount } = await client.query(
    `DELETE FROM vault_items WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, itemId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * An origin, as the browser would report it.
 *
 * Delegates to the gate's own normaliser rather than writing a second one — the
 * two would eventually disagree, and the version that decides what a user
 * *stored* must be the version that decides what they can *use*. A bare host is
 * accepted for typing convenience and becomes https, because a credential typed
 * into a cleartext page is the thing the scheme check exists to stop.
 */
function normalize(value: string): string {
  return normalizeOrigin(value.includes("://") ? value : `https://${value}`) ?? "";
}
