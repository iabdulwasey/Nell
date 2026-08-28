/**
 * @nell/core-app
 *
 * The headless Nell runtime and self-host entrypoint: the HTTP API, the durable
 * runtime, and the agent runtime. This is the process `docker compose up`
 * starts.
 *
 * Governed by: docs/architecture.md
 */

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { assertRlsEnforceable, createPool } from "./db.js";
import { createServer } from "./server.js";

export { loadConfig, capabilitiesOf, type Capabilities, type Config } from "./config.js";
export { assertRlsEnforceable, createPool, withWorkspace } from "./db.js";
export { createServer, type ServerDeps } from "./server.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  // Refuse to run with tenant isolation silently disabled.
  await assertRlsEnforceable(pool);

  const app = createServer({
    config,
    checkDatabase: async () => {
      await pool.query("SELECT 1");
      return true;
    },
  });

  const server = serve({ fetch: app.fetch, port: config.port });
  console.log(`Nell core listening on :${String(config.port)}`);

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down.`);
    server.close();
    void pool.end();
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

// Run when executed directly, not when imported by tests.
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
