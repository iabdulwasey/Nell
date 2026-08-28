/**
 * Database access.
 *
 * Two invariants live here:
 *
 * 1. The application role must NOT be able to bypass row-level security. A
 *    superuser connection silently disables tenant isolation, so the service
 *    refuses to start rather than run with a false sense of safety.
 * 2. Every tenant query runs inside a transaction that has published its
 *    workspace via SET LOCAL, so the scope cannot leak across a pooled
 *    connection.
 */

import { assertNotBypassingRlsSql, setWorkspaceSql } from "@nell/db";
import type { AccessScope } from "@nell/shared";
import { Pool, type PoolClient } from "pg";

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

/**
 * Boot-time guard. Fails loudly when the connected role can bypass RLS, because
 * the failure mode otherwise is silent cross-tenant data exposure.
 */
export async function assertRlsEnforceable(pool: Pool): Promise<void> {
  const result = await pool.query<{ bypasses_rls: boolean }>(assertNotBypassingRlsSql());
  if (result.rows[0]?.bypasses_rls) {
    throw new Error(
      "The database role can bypass row-level security (superuser or BYPASSRLS). " +
        "Tenant isolation would be silently disabled. Connect as a NOSUPERUSER " +
        "NOBYPASSRLS role — see packages/db appRoleSql()."
    );
  }
}

/**
 * Run a callback inside a transaction bound to one workspace. The workspace is
 * set with `SET LOCAL`, so it is scoped to this transaction and reset when the
 * connection returns to the pool.
 */
export async function withWorkspace<T>(
  pool: Pool,
  scope: AccessScope,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(setWorkspaceSql(), [scope.workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
