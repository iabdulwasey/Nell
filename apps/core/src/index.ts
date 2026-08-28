/**
 * @nell/core-app
 *
 * The headless Nell runtime and self-host entrypoint: the Hono API + webhooks +
 * channel ingress, the DBOS durable runtime, and the agent runtime. This is the
 * process that `docker compose up` starts.
 *
 * Governed by: docs/architecture.md
 *
 * Status: scaffold stub. The server, channel webhooks, and agent wiring land in
 * Phase 0 / v1 per docs/roadmap.md.
 */

export function main(): void {
  // TODO(phase-0): boot Hono, register channel webhooks, start the durable
  // runtime, mount the agent coordinator.
  console.log("Nell core — scaffold. Nothing to run yet.");
}
