/**
 * Database schema.
 *
 * One Postgres holds application data, durable-workflow state, queues, the
 * monitors table, and the audit log — the single stateful dependency that makes
 * `docker compose up` a complete deployment.
 *
 * Every tenant-scoped table carries `workspace_id` and is protected by row-level
 * security. Application code already filters by AccessScope; RLS is the backstop
 * that catches the query someone forgets to scope.
 */

import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** A tenant. One per user for personal use; shared workspaces later. */
export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_members_user_idx").on(table.userId),
  ]
);

/**
 * Vault item metadata. The secret itself lives in `vault_secrets` so that
 * listing items never reads ciphertext.
 */
export const vaultItems = pgTable(
  "vault_items",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    /** Non-secret hint shown in the UI, e.g. "Visa ending 4242". */
    accountHint: text("account_hint"),
    /** Origins this item may be filled into; enforced server-side at fill time. */
    origins: jsonb("origins").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("vault_items_workspace_idx").on(table.workspaceId)]
);

/** Ciphertext, stored apart from metadata and keyed by the same item id. */
export const vaultSecrets = pgTable(
  "vault_secrets",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().default("vault"),
    itemId: text("item_id").notNull(),
    /** `v2.<keyId>.<iv>.<authTag>.<ciphertext>` */
    encryptedValue: text("encrypted_value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.namespace, table.itemId] })]
);

/** One row per task the agent is running or has run. Drives the dashboard. */
export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    emoji: text("emoji"),
    status: text("status").notNull().default("queued"),
    /** Durable workflow handle; also the continuation key for follow-ups. */
    workflowId: text("workflow_id"),
    browserSessionId: text("browser_session_id"),
    browserProfileId: text("browser_profile_id"),
    /** Spend ceiling for this task, in minor units. */
    budgetAmount: integer("budget_amount"),
    spentAmount: integer("spent_amount").notNull().default(0),
    channelThreadRef: text("channel_thread_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tasks_workspace_status_idx").on(table.workspaceId, table.status)]
);

/** Purchase approvals: hash-bound, single-use, short-lived. */
export const approvals = pgTable(
  "approvals",
  {
    token: text("token").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    payloadHash: text("payload_hash").notNull(),
    /** The exact payload shown to the user, for the receipt and the audit log. */
    payload: jsonb("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    spentAt: timestamp("spent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("approvals_workspace_idx").on(table.workspaceId)]
);

/** Recurring checks. The heartbeat leases due rows with FOR UPDATE SKIP LOCKED. */
export const monitors = pgTable(
  "monitors",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** Which deterministic pre-check runs before any model call. */
    checkType: text("check_type").notNull(),
    checkConfig: jsonb("check_config").notNull().default({}),
    /** Prompt dispatched only when the pre-check reports a change. */
    prompt: text("prompt").notNull(),
    channelThreadRef: text("channel_thread_ref"),
    everyMinutes: integer("every_minutes"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("monitors_due_idx").on(table.enabled, table.nextRunAt)]
);

/** Digests of what a monitor already reported, so it never repeats itself. */
export const monitorReports = pgTable(
  "monitor_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    contentDigest: text("content_digest").notNull(),
    payload: jsonb("payload"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("monitor_reports_dedupe_idx").on(table.monitorId, table.contentDigest)]
);

/**
 * Exactly-once outbound delivery. A unique key makes enqueue idempotent; a
 * lease-drained worker sends. Sends never happen inline in a workflow step.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** Stable idempotency key; duplicate enqueues collapse. */
    dedupeKey: text("dedupe_key").notNull(),
    channel: text("channel").notNull(),
    threadRef: text("thread_ref").notNull(),
    body: text("body").notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_outbox_dedupe_idx").on(table.dedupeKey),
    index("notification_outbox_pending_idx").on(table.deliveredAt, table.leaseExpiresAt),
  ]
);

/** Tier-1 memory: durable user preferences, injected each coordinator turn. */
export const preferences = pgTable(
  "preferences",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    category: text("category").notNull(),
    /** Where this came from; untrusted-derived values never land here directly. */
    provenance: text("provenance").notNull(),
    confidence: text("confidence"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    supersededBy: text("superseded_by"),
  },
  (table) => [uniqueIndex("preferences_key_idx").on(table.workspaceId, table.key)]
);

/** Tier-2 memory: one row per completed task — "book it like last time". */
export const taskLedger = pgTable(
  "task_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    taskId: text("task_id"),
    objective: text("objective").notNull(),
    merchant: text("merchant"),
    outcome: text("outcome").notNull(),
    amount: integer("amount"),
    currency: text("currency"),
    detail: jsonb("detail").notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_ledger_workspace_idx").on(table.workspaceId, table.completedAt)]
);

/**
 * Standing rules, kept apart from facts on purpose.
 *
 * `preferences` holds what Nell *knows* — where you live, which airline you
 * like. This holds what Nell must *do*: always ask before spending over £50,
 * never message my landlord directly. The distinction is not tidiness, it is
 * that the two fail differently — a missed fact prompts a question, a missed
 * directive breaks a promise — and only one of them is something the user
 * expects to be obeyed rather than recalled.
 *
 * Superseded by revocation rather than deletion, so "you told me to stop doing
 * that on the 4th" stays answerable.
 */
export const directives = pgTable(
  "directives",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    rule: text("rule").notNull(),
    /** A directive can only ever come from the user; recorded so that is auditable. */
    provenance: text("provenance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("directives_workspace_idx").on(table.workspaceId, table.createdAt)]
);

/**
 * What was said, in order.
 *
 * The thing every other memory table assumed somebody else was keeping. There
 * are preferences (standing facts), a ledger (structured outcomes) and an audit
 * log (what was done) — and until this table there was nowhere holding the
 * conversation, so "book the second one" could not be answered and Nell's own
 * replies were never written down at all.
 *
 * **Provenance is a column because it decides what a turn may cause.** A user's
 * message is trusted: they are the principal. Nell's own replies are not, and
 * the reason is specific rather than cautious — a reply quotes web pages, so a
 * hostile page that gets quoted once would come back next turn as "conversation
 * history" and be read as instruction. That is injection taking the long way
 * round through us, and it is why recall renders these as a record of what was
 * said and never as something to obey.
 */
export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** "user" or "nell". */
    role: text("role").notNull(),
    body: text("body").notNull(),
    /** `user` only when the user wrote it. See the note above. */
    provenance: text("provenance").notNull(),
    /** Which task this turn belonged to, when it belonged to one. */
    taskId: text("task_id"),
    /** Files sent with this turn, by name, so "review it" resolves later. */
    files: jsonb("files").notNull().default([]),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_workspace_at_idx").on(table.workspaceId, table.at)]
);

/** Append-only hash-chained audit log. Never updated, never deleted. */
export const auditLog = pgTable(
  "audit_log",
  {
    sequence: integer("sequence").notNull(),
    workspaceId: text("workspace_id").notNull(),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    detail: jsonb("detail").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull(),
    previousDigest: text("previous_digest").notNull(),
    digest: text("digest").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.sequence] })]
);

/** Every tenant-scoped table that must carry an RLS policy. */
export const TENANT_TABLES = [
  "workspace_members",
  "vault_items",
  "vault_secrets",
  "tasks",
  "approvals",
  "monitors",
  "monitor_reports",
  "notification_outbox",
  "preferences",
  "task_ledger",
  "directives",
  "messages",
  "audit_log",
] as const;
