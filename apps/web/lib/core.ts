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
 * These were fixtures until now — real shapes with invented contents, so the
 * pages could be built and reviewed before anything wrote the rows. Every row
 * they stood in for now exists, so they read the database.
 *
 * **It reads and never writes.** Not a temporary state: the agent owns every
 * mutation, and a dashboard that could also write would be a second path into
 * the same tables with none of the gates attached to it. What the pages offer
 * instead are the commands that reach the agent, which is where the checks are.
 *
 * Reads go through `withWorkspace` from `@nell/db` — the same helper the agent
 * uses, deliberately, because a second implementation that forgot
 * `SET LOCAL app.workspace_id` would read across tenants and would not error
 * while doing it.
 */

import {
  capabilityReport,
  catalogLookup,
  overridesFromEnv,
  type Assignment,
  type CapabilityReport,
  type ModelCapability,
} from "@nell/agent";
import { appendEntry, verifyChain, type AuditEntry } from "@nell/audit";
import type { PurchasePayload } from "@nell/aegis";
import { createPool, withWorkspace } from "@nell/db";
import { accessScopeForUser, type AccessScope } from "@nell/shared";
import type {
  MachineState,
  MemoryEntryState,
  StoredKey,
  TaskSummary,
  VaultItemState,
} from "@nell/views";
import type { Pool } from "pg";

export function now(): number {
  return Date.now();
}

/**
 * One pool for the process, made on first use.
 *
 * Next.js re-evaluates modules across dev reloads, so a pool created at module
 * scope leaks a connection per reload until Postgres refuses new ones. Held on
 * `globalThis` for the same reason every Next.js database example does.
 */
const holder = globalThis as unknown as { __nellPool?: Pool };

function pool(): Pool | undefined {
  const url = process.env["DATABASE_URL"];
  if (!url) return undefined;
  holder.__nellPool ??= createPool(url);
  return holder.__nellPool;
}

/**
 * Whose dashboard this is.
 *
 * A single-owner install, matching the agent: the same `NELL_OWNER_TELEGRAM_ID`
 * that decides who may text it decides whose data this shows. There is no login
 * here yet, which is exactly why it must never be exposed beyond localhost —
 * said plainly in `docs/self-hosting.md` rather than left to be discovered.
 */
function scope(): AccessScope | undefined {
  const owner = process.env["NELL_OWNER_TELEGRAM_ID"];
  return owner ? accessScopeForUser(`tg-${owner}`) : undefined;
}

/** Empty rather than throwing, so a page renders an honest "nothing yet". */
async function read<T>(
  fn: (client: Parameters<Parameters<typeof withWorkspace>[2]>[0], s: AccessScope) => Promise<T>,
  fallback: T
): Promise<T> {
  const db = pool();
  const who = scope();
  if (!db || !who) return fallback;
  try {
    return await withWorkspace(db, who, (client) => fn(client, who));
  } catch {
    return fallback;
  }
}

/** `blocked-on-user` is the core's word; the views package says `blocked`. */
function stateOf(status: string): TaskSummary["state"] {
  switch (status) {
    case "blocked-on-user":
      return "blocked";
    case "running":
    case "queued":
    case "done":
    case "failed":
      return status;
    default:
      // `abandoned` and anything added later render as failed rather than
      // vanishing — a task that happened should be visible even if this page
      // has not learned its word for what happened.
      return "failed";
  }
}

export async function tasks(): Promise<readonly TaskSummary[]> {
  return read(async (client, who) => {
    const { rows } = await client.query<{
      id: string;
      label: string;
      status: string;
      blocked_on: string | null;
      updated_at: Date;
    }>(
      `SELECT id, label, status, blocked_on, updated_at FROM tasks
        WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [who.workspaceId]
    );

    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      state: stateOf(row.status),
      updatedAt: row.updated_at.getTime(),
      ...(row.blocked_on ? { blockedOn: row.blocked_on } : {}),
    }));
  }, []);
}

export interface PendingApproval {
  readonly taskId: string;
  readonly taskLabel: string;
  readonly requestedAt: number;
  readonly payload: PurchasePayload;
}

export async function pendingApprovals(): Promise<readonly PendingApproval[]> {
  return read(async (client, who) => {
    const { rows } = await client.query<{
      task_id: string | null;
      label: string | null;
      payload: PurchasePayload;
      created_at: Date;
    }>(
      `SELECT a.task_id, t.label, a.payload, a.created_at
         FROM approvals a
         LEFT JOIN tasks t ON t.id = a.task_id
        WHERE a.workspace_id = $1 AND a.spent_at IS NULL AND a.expires_at > now()
        ORDER BY a.created_at DESC`,
      [who.workspaceId]
    );

    return rows.map((row) => ({
      taskId: row.task_id ?? "",
      taskLabel: row.label ?? "a task",
      requestedAt: row.created_at.getTime(),
      payload: row.payload,
    }));
  }, []);
}

/**
 * The workspace's browser, described from what the tasks say.
 *
 * The machine registry is not persisted — one browser is held in the agent's
 * memory — so this is inferred rather than read: when it was first used, when
 * it was last used, and how many tasks it has served. Honest about being a
 * summary rather than a live handle, which is also why there is no destroy
 * button here: destroying it is the agent's to do, with a receipt.
 */
export async function machine(): Promise<MachineState> {
  return read(
    async (client, who) => {
      const { rows } = await client.query<{
        first: Date | null;
        last: Date | null;
        served: string;
      }>(
        `SELECT min(created_at) AS first, max(updated_at) AS last, count(*)::text AS served
           FROM tasks WHERE workspace_id = $1`,
        [who.workspaceId]
      );
      const row = rows[0];
      const served = Number(row?.served ?? 0);

      return {
        state: served > 0 ? ("standby" as const) : ("stopped" as const),
        createdAt: row?.first?.getTime() ?? Date.now(),
        // Falls back to creation rather than to now: a machine that has served
        // nothing was last used when it was made, and "used seconds ago" on an
        // idle install would be a small lie on a page about what is true.
        lastUsedAt: row?.last?.getTime() ?? row?.first?.getTime() ?? Date.now(),
        tasksServed: served,
      };
    },
    { state: "stopped", createdAt: Date.now(), lastUsedAt: Date.now(), tasksServed: 0 }
  );
}

export async function vaultItems(): Promise<readonly VaultItemState[]> {
  return read(async (client, who) => {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      label: string;
      origins: string[] | null;
      updated_at: Date;
    }>(
      `SELECT id, kind, label, origins, updated_at FROM vault_items
        WHERE workspace_id = $1 ORDER BY label`,
      [who.workspaceId]
    );

    // Metadata only. There is no column here that could carry a secret and no
    // query in this file that reads `vault_secrets` — the ciphertext never
    // reaches this process, let alone the page.
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as VaultItemState["kind"],
      label: row.label,
      origins: row.origins ?? [],
      updatedAt: row.updated_at.getTime(),
    }));
  }, []);
}

export async function memories(): Promise<readonly MemoryEntryState[]> {
  return read(async (client, who) => {
    const [preferences, notes] = await Promise.all([
      client.query<{ id: string; key: string; value: string; observed_at: Date }>(
        `SELECT id, key, value, observed_at FROM preferences
          WHERE workspace_id = $1 AND superseded_by IS NULL ORDER BY observed_at DESC`,
        [who.workspaceId]
      ),
      client.query<{ id: string; body: string; because: string | null; created_at: Date }>(
        `SELECT id, body, because, created_at FROM notes
          WHERE workspace_id = $1 AND superseded_by IS NULL AND kind = 'note'
          ORDER BY created_at DESC`,
        [who.workspaceId]
      ),
    ]);

    /**
     * `stated` for both, and that is not laziness.
     *
     * Lineage is the gate rather than a label: a preference can only be written
     * from something the user said, and a note only through `/remember`, which
     * *is* the user typing. Nothing in this system can produce a memory from
     * page text — so there is currently no honest way for a row here to be
     * anything other than stated, and inventing `observed` to make the column
     * look varied would misreport where a fact came from.
     */
    return [
      ...preferences.rows.map((row) => ({
        id: row.id,
        text: `${row.key}: ${row.value}`,
        importance: 5,
        learnedAt: row.observed_at.getTime(),
        lineage: "stated" as const,
      })),
      ...notes.rows.map((row) => ({
        id: row.id,
        text: row.body,
        importance: 5,
        learnedAt: row.created_at.getTime(),
        lineage: "stated" as const,
      })),
    ].sort((a, b) => b.learnedAt - a.learnedAt);
  }, []);
}

/**
 * The audit chain, read whole.
 *
 * Whole rather than paged, because the panel verifies it on every render and a
 * chain checked only from where the reader happens to be looking is a chain an
 * attacker breaks by deleting the part nobody looked at.
 */
export async function auditEntries(): Promise<readonly AuditEntry[]> {
  return read(async (client, who) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT sequence, workspace_id, action, subject, detail, at, previous_digest, digest
         FROM audit_log WHERE workspace_id = $1 ORDER BY sequence ASC`,
      [who.workspaceId]
    );

    return rows.map((row) => ({
      sequence: Number(row["sequence"]),
      workspaceId: String(row["workspace_id"]),
      action: row["action"] as AuditEntry["action"],
      subject: String(row["subject"]),
      detail: (row["detail"] ?? {}) as Record<string, unknown>,
      at: (row["at"] as Date).toISOString(),
      previousDigest: String(row["previous_digest"]),
      digest: String(row["digest"]),
    }));
  }, []);
}

/** Whether the chain still verifies — asked here so a page cannot forget to. */
export async function auditIsIntact(): Promise<boolean> {
  return verifyChain(await auditEntries()).valid;
}

export function storedKeys(): readonly StoredKey[] {
  /**
   * Which vendors have a key, and never the key.
   *
   * Read from the environment because that is where they live — there is no
   * table of keys, deliberately. Only the last four characters are shown, which
   * is enough to tell two keys apart and useless to anyone reading over a
   * shoulder.
   */
  const vendors: readonly [StoredKey["provider"], string][] = [
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["google", "GOOGLE_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"],
  ];

  return vendors
    .map(([provider, variable]) => ({ provider, key: process.env[variable] }))
    .filter((entry): entry is { provider: StoredKey["provider"]; key: string } =>
      Boolean(entry.key)
    )
    .map(({ provider, key }) => ({
      provider,
      hint: key.slice(-4),
      /**
       * Keys live in the environment, so there is no date to read.
       *
       * Reported as now rather than invented as a plausible past: a made-up
       * "added three weeks ago" on a page whose whole job is showing what is
       * true would be a small lie, and small lies here are the ones nobody
       * checks.
       */
      addedAt: Date.now(),
    }));
}

export function selectedModels(): Readonly<Record<"nano" | "worker" | "frontier", string>> {
  const chosen = process.env["NELL_MODEL"] ?? "anthropic/claude-sonnet-4-5";
  return { nano: chosen, worker: chosen, frontier: chosen };
}

/**
 * The default model, and who was assigned each job on top of it.
 *
 * Read from the same variables the agent reads, so the page and the process
 * cannot disagree about what is configured. That mattered within a minute of
 * this existing: with two lookups instead of one, `/models` reported that Nell
 * could not draw while it was drawing perfectly well.
 */
export function modelAssignment(): Assignment {
  return {
    defaultModel: process.env["NELL_MODEL"] ?? "anthropic/claude-sonnet-4-5",
    overrides: overridesFromEnv(process.env as Record<string, string | undefined>),
  };
}

/**
 * What this install can actually do — the answer the settings page is for.
 *
 * Derived, never stored. A capability is available only when a model is
 * assigned to it *and* that vendor has a key, which is the property the report
 * did not have: with only an Anthropic key and Google as the default it claimed
 * image generation, audio and embeddings, every one of them needing a Google
 * key that did not exist.
 */
export function capabilities(): CapabilityReport {
  return capabilityReport(
    modelAssignment(),
    catalogLookup,
    new Set(storedKeys().map((key) => key.provider))
  );
}

/**
 * Capabilities the running product actually consults the assignment for.
 *
 * The distinction this page cannot be allowed to blur. `image` is routed: the
 * picture tool is built from whatever the assignment resolves. The four served
 * by the assist path — reasoning, reading, searching, running code — resolve to
 * a model and then reach an implementation that **speaks Anthropic and nothing
 * else**, because its value is that vendor's server-side search and sandbox,
 * which resolve inside one request. And nothing in the product consumes `audio`
 * or `embed` at all yet.
 *
 * Shown rather than hidden, for the reason the whole screen exists: a setting
 * that quietly does nothing is worse than a setting that is absent. A person who
 * assigns web search to another vendor and sees the row accept it has been told
 * something untrue by software whose entire pitch is that it tells the truth.
 */
export const CAPABILITY_ROUTING: Readonly<Record<ModelCapability, string | undefined>> = {
  text: "Always runs on the default model — that is what choosing one means.",
  vision: "Always runs on the default model.",
  search:
    "Runs on the default model, whichever vendor it is: searching is a tool Nell provides, " +
    "not something borrowed from the model's vendor.",
  code:
    "Needs a vendor sandbox, which only Anthropic's models reach today. Nell will say it " +
    "cannot rather than describing a file it never made.",
  image: undefined,
  audio: "Nothing in Nell uses speech yet.",
  embed: "Recall works without embeddings today; nothing uses this yet.",
};

export function ago(at: number, reference: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((reference - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

export { appendEntry };
