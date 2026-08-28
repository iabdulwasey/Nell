# ADR 0001 — Durable execution engine: DBOS Transact

**Status:** Accepted (2026-08-29)

## Context

Nell runs long-lived agent tasks that must (a) survive a process crash mid-task
and resume from the last completed step, (b) park at zero compute cost while
waiting hours or days for a human approval, an OAuth grant, or a monitor tick,
(c) provide queues with per-workspace concurrency caps, (d) run cron/scheduled
work (the proactivity heartbeat), and (e) guarantee exactly-once side effects for
money and outbound messages. Self-hosting is a first-class product: `docker
compose up` must yield a working agent with the fewest possible stateful
dependencies — ideally one Postgres.

## Decision

Use **DBOS Transact** (`@dbos-inc/dbos-sdk`, MIT) as the durable-execution
engine for v1 single-node self-host.

It is the only option that delivers durable crash-resume, zero-cost parking,
Postgres-native queues, cron, and exactly-once idempotency as a plain TypeScript
library needing nothing but the Postgres we already run — no separate
orchestration cluster (Temporal), no Redis (Inngest), no object store (Restate).
Critically, it commits the durability record and the app's own writes in the
same Postgres transaction, which is what actually delivers exactly-once side
effects.

## Alternatives considered

- **Restate** — the strongest runner-up; best TypeScript ergonomics (no
  determinism constraints) and clean parking via awakeables. Rejected because its
  state lives in embedded storage plus a required object store for HA, separate
  from the app Postgres — breaking the one-stateful-dependency promise and
  forfeiting transactional exactly-once. Documented as the fallback.
- **Temporal** — most mature, but a multi-service cluster; disqualified by the
  self-host footprint and its history-size limits that fight long agent loops.
- **Inngest** — adds Redis to the stateful footprint.
- **Hand-rolled on Postgres** — the only other one-Postgres option, but ships
  at-least-once by default and means rebuilding what DBOS already is.

## Consequences and guardrails

- **Reversibility seam:** all DBOS-specific code sits behind a thin
  `DurableEngine` port in `packages/durable`. Business code imports the port;
  exactly one adapter file imports the SDK. Swapping to Restate later is a new
  adapter, not a refactor.
- **Determinism discipline:** every LLM call, browser action, tool call,
  timestamp, and random value must be wrapped in a step. This is lint-enforced in
  CI.
- **Deferred risk:** DBOS's automatic cross-executor recovery at elastic
  multi-node scale is a paid/DIY concern. v1 is single-node and ID-pinned, where
  recovery is automatic and free. We revisit before horizontal scale.
- **First task:** a crash-resume spike (start a multi-step workflow, SIGKILL
  mid-step, restart, assert resume-from-checkpoint and exactly-once side effect)
  gates building product on the engine.

## Spike result — PASSED (2026-08-29)

`packages/durable/src/spike/crash-resume.ts`, run against a real PostgreSQL 17
instance. A three-step workflow (charge → book → receipt) was hard-killed with
SIGKILL from inside step 2, then the process was restarted.

Observed step log across both passes:

```
charge-card -> book-table-crashed-before-completion -> book-table -> send-receipt
```

- **Exactly-once side effect:** `charge-card` appears once. The completed step
  was not re-executed on recovery — the card is not charged twice.
- **Resume from checkpoint:** the workflow continued at step 2 rather than
  restarting, and the engine logged `Recovering 1 workflows` on launch.
- **Completion:** step 3 ran, so recovery carried the workflow to the end.

This is the "kill the server mid-task on stage and it finishes" demo, validated
on real infrastructure before any product code was built on the engine.

**Finding from the spike:** `DBOSConfig` has no `databaseUrl` field — the
correct key is `systemDatabaseUrl`. An initial run appeared to work only because
the SDK fell back to the `DBOS_DATABASE_URL` environment variable; the
typechecker caught the mismatch that the runtime had masked. The adapter now
passes `systemDatabaseUrl` explicitly.
