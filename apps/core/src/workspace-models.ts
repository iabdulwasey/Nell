/**
 * Whose keys, and whose choice of model — per workspace.
 *
 * The commercial case the architecture describes and nothing implemented.
 * `mergeAssignments` has defined the precedence since the day it was written —
 * operator first, workspace over it, per capability — and **had no caller**, so
 * the assignment was per *process*: right for somebody running Nell for
 * themselves, and insufficient the moment there are two people.
 *
 * Two layers, and self-host is the same code with the upper one empty:
 *
 * - **The operator layer** is the environment. The admin's keys, serving
 *   everyone, and the default model everything falls back to.
 * - **The workspace layer** is these tables. A tenant may bring its own key and
 *   choose its own models — *if the deployment permits it*, which is a policy
 *   decision an operator selling a service may well answer no to.
 *
 * **Whether a workspace may choose is not decided here.** The caller passes
 * `undefined` for the workspace layer when user choice is not allowed, which is
 * a rule that cannot be forgotten halfway down a function — the same reason
 * `mergeAssignments` refuses to take the flag itself.
 *
 * **The key is encrypted with the vault's crypto under its own namespace.** Not
 * a vault *item*: a vault item is a credential for somebody else's website,
 * typed into a page by a browser, so it is origin-bound and taints the session.
 * An API key is used by this process to call a vendor — never typed, never on a
 * page, no origin to bind to. What genuinely transfers is the envelope
 * encryption, and the namespace in the AAD is what stops one being decrypted as
 * the other.
 */

import { mergeAssignments, type ModelCapability } from "@nell/agent";
import type { AccessScope } from "@nell/shared";
import { decryptSecret, encryptSecret, type KeyProvider } from "@nell/vault";
import type { PoolClient } from "pg";
import { z } from "zod";

/** Kept apart from the vault's, so a swapped ciphertext fails to decrypt. */
export const KEY_NAMESPACE = "provider-keys";

export interface WorkspaceChoice {
  readonly defaultModel?: string;
  readonly overrides: Readonly<Partial<Record<ModelCapability, string>>>;
}

const overridesSchema = z.record(z.string(), z.string()).default({});

/**
 * What this workspace has chosen, or nothing.
 *
 * Undefined rather than an empty object when the workspace has chosen nothing,
 * because the two mean different things to the merge: absent leaves the
 * operator's answer untouched, and an empty override map does the same but says
 * something was configured.
 */
export async function readChoice(
  client: PoolClient,
  scope: AccessScope
): Promise<WorkspaceChoice | undefined> {
  const { rows } = await client.query<{ default_model: string | null; overrides: unknown }>(
    `SELECT default_model, overrides FROM workspace_models WHERE workspace_id = $1`,
    [scope.workspaceId]
  );

  const row = rows[0];
  if (!row) return undefined;

  const overrides = overridesSchema.safeParse(row.overrides);
  return {
    ...(row.default_model ? { defaultModel: row.default_model } : {}),
    overrides: overrides.success
      ? (overrides.data as Partial<Record<ModelCapability, string>>)
      : {},
  };
}

export async function setChoice(
  client: PoolClient,
  scope: AccessScope,
  choice: WorkspaceChoice
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_models (workspace_id, default_model, overrides, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (workspace_id) DO UPDATE
       SET default_model = EXCLUDED.default_model,
           overrides = EXCLUDED.overrides,
           updated_at = now()`,
    [scope.workspaceId, choice.defaultModel ?? null, JSON.stringify(choice.overrides)]
  );
}

export interface StoredKeySummary {
  readonly vendor: string;
  /** Enough to recognise, never enough to use. */
  readonly hint: string;
  readonly addedAt: number;
}

export async function listKeys(
  client: PoolClient,
  scope: AccessScope
): Promise<readonly StoredKeySummary[]> {
  const { rows } = await client.query<{ vendor: string; hint: string; added_at: Date }>(
    `SELECT vendor, hint, added_at FROM workspace_keys WHERE workspace_id = $1 ORDER BY vendor`,
    [scope.workspaceId]
  );
  return rows.map((row) => ({
    vendor: row.vendor,
    hint: row.hint,
    addedAt: row.added_at.getTime(),
  }));
}

/**
 * Store a key for this workspace.
 *
 * The hint is the last four characters and is stored rather than derived,
 * because deriving it would mean decrypting every key to render a list — which
 * is a lot of exposure to answer "which key is this".
 */
export async function saveKey(
  client: PoolClient,
  scope: AccessScope,
  keys: KeyProvider,
  vendor: string,
  apiKey: string
): Promise<void> {
  const ciphertext = await encryptSecret(
    keys,
    { workspaceId: scope.workspaceId, namespace: KEY_NAMESPACE, itemId: vendor },
    apiKey
  );

  await client.query(
    `INSERT INTO workspace_keys (workspace_id, vendor, ciphertext, hint, added_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (workspace_id, vendor) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext, hint = EXCLUDED.hint, added_at = now()`,
    [scope.workspaceId, vendor, ciphertext, apiKey.slice(-4)]
  );
}

export async function forgetKey(
  client: PoolClient,
  scope: AccessScope,
  vendor: string
): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM workspace_keys WHERE workspace_id = $1 AND vendor = $2`,
    [scope.workspaceId, vendor]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The key to use for a vendor: this workspace's, or the operator's.
 *
 * The precedence that makes hosted and self-hosted one codebase. A workspace
 * that brought its own key pays for its own usage; one that did not rides on the
 * operator's, which is the ordinary case and the reason the service works at all
 * before anybody configures anything.
 *
 * Returns undefined rather than throwing on a key that will not decrypt. A
 * rotated master key leaves rows that cannot be read, and the honest behaviour
 * is the same as having no key — the settings screen says so and offers the way
 * to fix it, rather than the process failing to start.
 */
export async function resolveKey(
  client: PoolClient,
  scope: AccessScope,
  keys: KeyProvider | undefined,
  vendor: string,
  operatorKey: string | undefined
): Promise<string | undefined> {
  if (!keys) return operatorKey;

  const { rows } = await client.query<{ ciphertext: string }>(
    `SELECT ciphertext FROM workspace_keys WHERE workspace_id = $1 AND vendor = $2`,
    [scope.workspaceId, vendor]
  );

  const row = rows[0];
  if (!row) return operatorKey;

  try {
    const decrypted = await decryptSecret(
      keys,
      { workspaceId: scope.workspaceId, namespace: KEY_NAMESPACE, itemId: vendor },
      row.ciphertext
    );
    return decrypted.expose();
  } catch {
    return operatorKey;
  }
}

/**
 * Whether a workspace may choose at all.
 *
 * An operator selling a service has a real reason to answer no: their margin
 * depends on which models run, and a tenant free to select the most expensive
 * one is a tenant free to spend their money. Self-host says yes, because there
 * the operator and the user are the same person.
 *
 * Read from the environment rather than the database on purpose — it is the
 * operator's policy about the whole deployment, not a per-tenant setting, and a
 * per-tenant switch controlling whether tenants may switch things is a circle.
 */
export function userChoiceAllowed(env: NodeJS.ProcessEnv): boolean {
  const setting = env["NELL_ALLOW_USER_MODELS"]?.trim().toLowerCase();
  // Default on: the overwhelmingly common deployment is one person running it
  // for themselves, and making them set a flag to configure their own install
  // would be asking permission from themselves.
  return setting !== "0" && setting !== "false" && setting !== "no";
}

/**
 * The assignment this workspace actually runs under.
 *
 * The call `mergeAssignments` was written for and never had. Precedence lives
 * there rather than here so it is defined once — most specific wins, **per
 * capability rather than per object**, because a workspace that overrides only
 * drawing must keep the operator's choice for everything else. Merging at the
 * wrong depth would silently discard settings the admin made.
 */
export async function assignmentFor(
  client: PoolClient,
  scope: AccessScope,
  operator: {
    defaultModel: string;
    overrides?: Readonly<Partial<Record<ModelCapability, string>>>;
  },
  allowed: boolean
): Promise<{
  defaultModel: string;
  overrides: Readonly<Partial<Record<ModelCapability, string>>>;
}> {
  // Not permitted means the workspace layer is not consulted at all, rather
  // than read and then ignored — an unread row cannot be accidentally honoured.
  const chosen = allowed ? await readChoice(client, scope) : undefined;
  const merged = mergeAssignments(operator, chosen);
  return { defaultModel: merged.defaultModel, overrides: merged.overrides ?? {} };
}
