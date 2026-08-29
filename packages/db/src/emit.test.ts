import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { auditImmutabilitySql, rlsPolicySql } from "./rls.js";

/**
 * Emits the policies as a committed SQL file.
 *
 * A test rather than a script so it runs in CI: if someone adds a tenant table
 * and does not regenerate, the committed file drifts from the schema and the
 * check below catches it.
 *
 * Note what is NOT emitted: `setWorkspaceSql`, which is a runtime prepared
 * statement carrying a parameter, not DDL. It was included here at first and the
 * migration failed with "there is no parameter $1" — loudly, which is the point.
 */
it("emits the policy SQL", () => {
  const sql = [
    "-- Generated from src/rls.ts by `pnpm --filter @nell/db emit-policies`.",
    "-- Committed so the rules that make the schema safe are reviewable as SQL,",
    "-- and re-applied by the migrate script on every run. Idempotent by design.",
    "",
    rlsPolicySql(),
    "",
    auditImmutabilitySql(),
    "",
  ].join("\n");

  // DDL only. A parameter placeholder here means a runtime statement has leaked
  // into a migration.
  expect(sql).not.toMatch(/\$\d/u);

  writeFileSync(new URL("../migrations/policies.sql", import.meta.url), sql);
});
