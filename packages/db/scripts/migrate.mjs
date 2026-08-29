/**
 * Apply migrations, then the policies Drizzle does not model.
 *
 * Row-level security, the audit log's append-only rule, and the refusal to run
 * as a superuser are all expressed as raw SQL because they are not schema in the
 * ORM's sense — they are the rules that make the schema safe. Running them from
 * the same command as the migrations means there is no window in which tables
 * exist without their policies.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS _nell_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const applied = new Set(
  (await client.query("SELECT name FROM _nell_migrations")).rows.map((row) => row.name)
);

const pending = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  // policies.sql is re-applied every run rather than once, so it is not a
  // migration. Leaving it in the numbered set would record it as applied and
  // then apply it again anyway — harmless, and confusing to read.
  .filter((file) => file !== "policies.sql")
  .sort()
  .filter((file) => !applied.has(file));

for (const file of pending) {
  const sql = readFileSync(join(migrationsDir, file), "utf8");
  // Drizzle separates statements with this marker; splitting on semicolons
  // would break any function body or dollar-quoted string.
  const statements = sql.split("--> statement-breakpoint");

  await client.query("BEGIN");
  try {
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
    await client.query("INSERT INTO _nell_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`applied ${file}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`failed ${file}: ${error.message}`);
    process.exit(1);
  }
}

if (pending.length === 0) console.log("no pending migrations");

/**
 * Policies, and then proof that they took.
 *
 * The first version of this imported the TypeScript source and wrapped it in a
 * catch. The import could not work from a .mjs script, the catch swallowed it,
 * and the script printed "applied" while every table sat with row-level
 * security switched off. A migration that reports success having skipped the
 * security policies is worse than one that fails, because nobody looks again.
 *
 * So: the SQL is a committed file, a missing file is fatal, and the run ends by
 * asking the database whether the policies are actually there. The verification
 * is the part that matters — everything above it is a claim.
 */
const policiesPath = join(migrationsDir, "policies.sql");
let policies;
try {
  policies = readFileSync(policiesPath, "utf8");
} catch {
  console.error(`Cannot read ${policiesPath}. Refusing to leave the schema without policies.`);
  await client.end();
  process.exit(1);
}

await client.query(policies);

/**
 * Which tables are tenant-scoped is asked of the database, not listed here.
 *
 * This script used to carry its own copy of the list, and it had silently
 * fallen two tables behind the schema — `directives` and `messages` were both
 * absent, so the gate that exists to prove row-level security is live would have
 * reported "verified" while a new table sat wide open. A security check that
 * fails open through drift is worse than no check, because it is quoted in the
 * README as though it means something.
 *
 * The rule that cannot drift: **a table with a `workspace_id` column belongs to
 * a tenant, and must have RLS forced.** That is true by construction rather than
 * by anybody remembering, and it covers a table added tomorrow by someone who
 * never reads this file. `workspaces` is correctly excluded — it has `id`, not
 * `workspace_id`, because it is the registry that *defines* tenants rather than
 * a table scoped to one.
 */
const { rows: tenantTables } = await client.query(
  `SELECT c.relname,
          (c.relrowsecurity AND c.relforcerowsecurity) AS protected
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'workspace_id'
      AND NOT a.attisdropped
    ORDER BY c.relname`
);

if (tenantTables.length === 0) {
  console.error("Found no tenant tables at all — the schema did not apply.");
  await client.end();
  process.exit(1);
}

const unprotected = tenantTables.filter((row) => !row.protected);
if (unprotected.length > 0) {
  console.error(
    `Row-level security is NOT active on: ${unprotected.map((r) => r.relname).join(", ")}`
  );
  await client.end();
  process.exit(1);
}

const {
  rows: [{ count: policyCount }],
} = await client.query(
  "SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public'"
);

if (policyCount < tenantTables.length) {
  console.error(`Expected at least ${tenantTables.length} policies, found ${policyCount}.`);
  await client.end();
  process.exit(1);
}

console.log(
  `row-level security verified on ${tenantTables.length} tables (${policyCount} policies)`
);

await client.end();
