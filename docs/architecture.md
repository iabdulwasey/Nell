# Architecture

Nell is a modular monolith: one deployable process image plus a Postgres and a
browser. The design thesis is **every dangerous thing a personal agent does, we
do by construction, not by convention** — enforced in server code, durable
against crashes, with provable deletion.

## Invariants

1. **The model is untrusted.** Every consequential boundary (secrets, spend,
   origins, outbound messages, memory writes) is enforced in server code the
   model cannot argue with.
2. **One stateful dependency.** Postgres is the database, the durable-execution
   log, the queue, the vector index, the audit log, and the outbox.
3. **Nothing user-facing is lost on crash.** Every task, monitor, approval, and
   notification is a durable workflow step or an outbox row.
4. **Deletion is provable.** Derived data is rebuildable and therefore honestly
   deletable; retained data (audit) is pseudonymized.

## Layers

- **Durable core** (`packages/durable`) — a `DurableEngine` port over DBOS
  Transact (see ADR 0001). Workflows, steps, queues, cron, parking.
- **Policy engine / Aegis** (`packages/aegis`) — the tool-executor chokepoint:
  spend approvals, provenance gate, origin allowlists, taint machine, audit.
- **Vault** (`packages/vault`) — AES-256-GCM envelope encryption; secretless
  autofill; the model sees only opaque handles.
- **Agent** (`packages/agent`) — a coordinator (owns the relationship, task
  registry, steering, approvals; never drives a browser or sees secrets) and
  workers (one durable workflow per task, briefed with just what they need).
- **Browser** (`packages/browser`) — a `BrowserProvider` (Kernel + local
  Chromium) with a typed action DSL; no model-authored code on secret-bearing
  sessions.
- **Channels** (`packages/channels`) — a `ChannelPort` with a canonical
  idempotent envelope and per-channel renderers (Telegram, WhatsApp, iMessage,
  web, voice).
- **Memory** (`packages/memory`) — preference profile, episodic task ledger,
  playbooks, and a rebuildable semantic index.
- **Integrations** (`packages/integrations`) — OAuth-held connectors behind
  quarantined readers that emit only schema-validated data.
- **Audit** (`packages/audit`) — append-only, hash-chained log of every
  consequential action.
- **`ee/`** — the commercial layer (billing, multi-tenant control plane,
  virtual-card issuing, admission control), key-gated at runtime.

See [`roadmap.md`](roadmap.md) for what lands when.
