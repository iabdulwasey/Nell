/**
 * @nell/db
 *
 * Drizzle schema, migrations, and row-level-security policies over the single
 * Postgres. Owns the tenant tables, the monitors table, and the audit log.
 *
 * Governed by: docs/architecture.md
 */

export {
  approvals,
  auditLog,
  monitorReports,
  monitors,
  notificationOutbox,
  preferences,
  taskLedger,
  tasks,
  TENANT_TABLES,
  vaultItems,
  vaultSecrets,
  workspaceMembers,
  workspaces,
} from "./schema.js";

export {
  appRoleSql,
  assertNotBypassingRlsSql,
  auditImmutabilitySql,
  rlsPolicySql,
  setWorkspaceSql,
  WORKSPACE_SETTING,
} from "./rls.js";
