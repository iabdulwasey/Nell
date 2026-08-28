/**
 * Row-level security.
 *
 * Application code always filters by AccessScope. RLS is the backstop for the
 * query nobody remembered to scope: the database itself refuses to return rows
 * belonging to another workspace.
 *
 * The request's workspace is published to Postgres per transaction with
 * `SET LOCAL app.workspace_id`, so it cannot leak across pooled connections.
 */

import { TENANT_TABLES } from "./schema.js";

/** GUC that carries the current request's workspace into the database. */
export const WORKSPACE_SETTING = "app.workspace_id";

/**
 * CRITICAL DEPLOYMENT REQUIREMENT.
 *
 * PostgreSQL superusers — and any role with BYPASSRLS — ignore row-level
 * security entirely, even on a table marked FORCE ROW LEVEL SECURITY. If the
 * application connects as `postgres`, every policy below silently does nothing
 * and cross-tenant reads succeed.
 *
 * Verified against PostgreSQL 17: connecting as a superuser returned rows from
 * every workspace; connecting as a NOSUPERUSER NOBYPASSRLS role returned only
 * the scoped workspace and rejected a cross-tenant insert.
 *
 * The application role must therefore be created as below, and migrations
 * (which need DDL) must run as a *separate*, more privileged role.
 */
export function appRoleSql(role: string, password: string): string {
  return `
CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role};`;
}

/**
 * Guard to run at boot: refuse to start if the application's database role can
 * bypass RLS. A misconfigured role is a silent tenancy failure, so this fails
 * loudly instead.
 */
export function assertNotBypassingRlsSql(): string {
  return `SELECT rolsuper OR rolbypassrls AS bypasses_rls
          FROM pg_roles WHERE rolname = current_user`;
}

/**
 * SQL enabling RLS and installing an isolation policy on every tenant table.
 *
 * `FORCE ROW LEVEL SECURITY` matters: without it the table owner (often the
 * migration role) bypasses policies, which would silently defeat the backstop.
 */
export function rlsPolicySql(): string {
  return TENANT_TABLES.map(
    (table) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${table}_workspace_isolation ON ${table};
CREATE POLICY ${table}_workspace_isolation ON ${table}
  USING (workspace_id = current_setting('${WORKSPACE_SETTING}', true))
  WITH CHECK (workspace_id = current_setting('${WORKSPACE_SETTING}', true));`
  ).join("\n");
}

/**
 * The audit log is append-only: no updates, no deletes, for anyone. Tampering
 * would break the hash chain anyway, but the database should not permit the
 * attempt in the first place.
 */
export function auditImmutabilitySql(): string {
  return `
DROP POLICY IF EXISTS audit_log_no_update ON audit_log;
CREATE POLICY audit_log_no_update ON audit_log FOR UPDATE USING (false);
DROP POLICY IF EXISTS audit_log_no_delete ON audit_log;
CREATE POLICY audit_log_no_delete ON audit_log FOR DELETE USING (false);`;
}

/** Statement binding a transaction to one workspace. Parameterized by caller. */
export function setWorkspaceSql(): string {
  return `SELECT set_config('${WORKSPACE_SETTING}', $1, true)`;
}
