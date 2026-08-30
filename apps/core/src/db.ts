/**
 * Database access, re-exported.
 *
 * The implementation moved to `@nell/db` when the dashboard needed the same
 * connection helper: `withWorkspace` publishes the workspace with `SET LOCAL`,
 * and a second copy of that which forgot to would read across tenants without
 * erroring. One implementation, two callers.
 *
 * Re-exported rather than deleted so every call site in this app keeps working —
 * the alternative was touching a dozen files to prove a point about where a
 * function lives.
 */

export { assertRlsEnforceable, createPool, withWorkspace } from "@nell/db";
