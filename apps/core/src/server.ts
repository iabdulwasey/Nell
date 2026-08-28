/**
 * HTTP surface.
 *
 * Deliberately thin: the server terminates requests and hands them to the
 * policy-guarded runtime. No security decision is made here — the policy engine
 * is the chokepoint, and putting a check in a route handler would create a
 * second place for it to be wrong.
 */

import { Hono } from "hono";
import { isLicensed } from "@nell/license";
import { capabilitiesOf, type Config } from "./config.js";

export interface ServerDeps {
  readonly config: Config;
  /** Reports whether the database is reachable. */
  readonly checkDatabase: () => Promise<boolean>;
}

export function createServer(deps: ServerDeps): Hono {
  const app = new Hono();

  /** Liveness: the process is up. Never touches the database. */
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  /**
   * Readiness: the process can actually serve. Reports which capabilities are
   * configured so a self-hoster can see what is missing without reading logs.
   */
  app.get("/readyz", async (c) => {
    const databaseReachable = await deps.checkDatabase().catch(() => false);
    const capabilities = capabilitiesOf(deps.config);
    const ready = databaseReachable;

    return c.json(
      {
        status: ready ? "ready" : "degraded",
        database: databaseReachable ? "reachable" : "unreachable",
        capabilities,
        /** Commercial features are off unless a valid signed key is present. */
        commercial: {
          billing: isLicensed("billing"),
          controlPlane: isLicensed("control-plane"),
        },
      },
      ready ? 200 : 503
    );
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.onError((error, c) => {
    // Log the detail; return a generic message so internals do not leak.
    console.error("Unhandled request error:", error);
    return c.json({ error: "Something went wrong." }, 500);
  });

  return app;
}
