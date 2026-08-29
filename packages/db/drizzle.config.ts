/**
 * Migration generation.
 *
 * Migrations are generated and committed rather than applied from the schema at
 * boot. A schema-push on startup is convenient until the first time it decides a
 * column rename is a drop-and-recreate, at which point it is a data-loss
 * incident that ran automatically.
 */
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
  strict: true,
} satisfies Config;
