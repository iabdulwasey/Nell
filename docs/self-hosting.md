# Self-hosting Nell

Nell is built to self-host with one command and one stateful dependency
(Postgres). The commercial `ee/` features are not needed to run the personal
agent.

## Prerequisites

- Docker + Docker Compose
- A `SECRET_ENCRYPTION_KEY` (`openssl rand -base64 32`)
- A Kernel API key for browser automation, and a model-gateway key for inference
  (see `.env.example`)

## Run

```bash
cp .env.example .env
# edit .env: DATABASE_URL, SECRET_ENCRYPTION_KEY, KERNEL_API_KEY, MODEL_GATEWAY_API_KEY
docker compose -f deploy/compose/docker-compose.yml up
```

This starts the core process, the web dashboard, Postgres, and a browser
sidecar. Everything the personal agent needs runs from this one image.

## What you get for free

The full personal agent: chat + channels, the encrypted vault, browser tasks
with approvals, memory, and proactivity/monitors — all under the FSL license, all
auditable.

## What requires a commercial license

The `ee/` features (billing, multi-tenant control plane, virtual-card issuing,
referral/waitlist admission) — i.e. the pieces you'd need to run Nell **as a paid
service for other people**. They are present in the source but stay disabled
without a valid license key. See
[`adr/0002-licensing-open-core.md`](adr/0002-licensing-open-core.md).

## What runs today

`docker compose up` starts Postgres and the Nell core service. The core exposes:

- `GET /healthz` — liveness (never touches the database)
- `GET /readyz` — readiness, plus which capabilities are configured and whether
  any commercial features are licensed

The dashboard and browser sidecar are commented out in the compose file and get
enabled as they land (see [`roadmap.md`](roadmap.md)).

## The database role matters

Compose provisions a `nell_app` role that is `NOSUPERUSER NOBYPASSRLS`, and the
service connects as that role. **This is not optional.** PostgreSQL superusers
ignore row-level security entirely, so connecting as the database owner would
silently disable tenant isolation. Nell refuses to boot in that configuration
and tells you why:

```
Error: The database role can bypass row-level security (superuser or BYPASSRLS).
Tenant isolation would be silently disabled.
```

If you are running Postgres yourself rather than through compose, create the
application role the same way — see `appRoleSql()` in `packages/db`.

## Durable execution (optional, and worth turning on)

Nell keeps workflow state in a **second database on the same server**, so a task
killed mid-flight resumes from its last completed step instead of being lost.
Without it everything works; a crash simply loses whatever was in progress.

It is a separate database rather than a schema because that state is not
tenant-scoped: it would need row-level security policies that do not exist, and
putting it beside application tables would mean writing them.

Create it once, as a role that may create databases — the application role
deliberately cannot:

```sql
CREATE DATABASE nell_dev_dbos_sys OWNER nell_app;
```

The name is your application database with `_dbos_sys` appended.

**If it is missing, Nell still starts.** The engine is given ten seconds and
then given up on, with a line in the log saying so. That bound exists because
the failure mode without it is worse than the feature: a durable engine that
cannot reach its system database _hangs_ rather than erroring, so the whole
agent would never finish starting and the only symptom would be silence.
