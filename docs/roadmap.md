# Roadmap

Phases from scaffold to full platform. Dates are relative; scope is the point.

## Step 1 — Scaffold (this commit)

Git-ready monorepo: package skeleton, licenses, tooling, CI, docs. No trust-core
logic yet. The `DurableEngine` port and the license-key seam exist so later work
drops into the right shape.

## Phase 0 — Trust core

The security foundation, built before any user-facing capability.

**Done** (119 tests; all packages typecheck; zero lint errors):

- ✅ **DBOS crash-resume spike** — passed on real PostgreSQL. A workflow
  SIGKILLed mid-step resumed from its checkpoint with the side-effecting step
  running exactly once. The engine choice is validated, not assumed.
- ✅ **DB schema + row-level security** — verified on PostgreSQL 17: scoped
  reads see one workspace, unscoped reads see nothing, cross-tenant writes are
  rejected. The service refuses to boot if its role can bypass RLS.
- ✅ **Vault** — AES-256-GCM, per-item AAD binding, key-id wire format for live
  rotation, `Secret<T>` that cannot be logged, structured item schemas (CVC
  never stored).
- ✅ **Typed browser DSL + taint machine** — a closed action vocabulary with no
  code-execution escape hatch; value reads blocked after a credential fill.
- ✅ **Policy engine** — spend gate with hash-bound single-use approvals, origin
  allowlist, provenance gate.
- ✅ **Audit** — append-only hash chain that detects edits, deletions and
  reordering.
- ✅ **ModelRouter + metering** — three tiers with bounded escalation and a
  per-workspace circuit breaker that refuses a call before making it.
- ✅ **Eval harness** — anti-cheat scoring plus adversarial refusal scenarios.
- ✅ **International phone identity** — 20 regions; refuses to guess rather than
  defaulting to +1.
- ✅ **`docker compose up`** — Postgres plus a bootable core service with
  liveness/readiness endpoints, running as a restricted database role.

**Remaining:**

- `BrowserProvider` adapter implementations (cloud service + local Chromium).
  The port and DSL exist; the adapters need vendor credentials to build against.
- Full auth wiring (OTP delivery, passkeys, recovery codes) on top of the phone
  identity layer.

## v1 — The magic demo

Coordinator/worker + task registry + steering + digests; web dashboard + Telegram
(per-task topics); DOM-first browsing + vision fallback + web search; memory
tiers 1–2 (preferences + episodic ledger) with deletion receipts; monitors +
proactivity; Gmail read/draft behind the quarantined reader (the injection-
refusal demo); live-view handoff to your phone for CAPTCHAs; per-user/BYOK model
choice.

Demo beats: book with exact-payload approval → kill the server mid-task, it
finishes → "same as last time" from memory → a monitor pings only on a real
change → an attacker email is refused with a visible audit entry.

## v2 — Parity-plus

WhatsApp + iMessage + voice; integrations wave 2 (Calendar, Outlook, Slack,
Notion, Linear, GitHub, user MCP servers); email write-ops; TOTP vault kind +
per-use-approval scoped OTP; memory tiers 3–4; single-use virtual cards;
subscription audits, flight book→rebook→verify; hosted-cloud beta (billing,
budgets, admission control).

## v3 — Beyond

Desktop companion driving the user's own local browser (the real answer to
CAPTCHAs and residential-IP checks); race mode; outbound negotiation calls;
signed community recipe marketplace; household workspaces; published task
benchmark.
