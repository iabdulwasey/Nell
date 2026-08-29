# Roadmap

Phases from scaffold to full platform. Dates are relative; scope is the point.

> **The distinction this document tries to keep honest** is not built versus
> unbuilt. It is **reachable from a chat message** versus **built, tested and
> unreachable**. Both halves are real code with real tests, and only one can
> affect you — and blurring them is how a roadmap ends up claiming a phase is
> complete because its decision layer is.

## Step 1 — Scaffold

Git-ready monorepo: package skeleton, licenses, tooling, CI, docs. The
`DurableEngine` port and the license-key seam exist so later work drops into the
right shape.

## Phase 0 — Trust core

The security foundation, built before any user-facing capability.

**Done:**

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

- ✅ **Local Chromium browser adapter** — implements `BrowserProvider` over
  Playwright, with seven integration tests driving a real browser against an
  in-process server (navigation, form fill, extraction, screenshots, session
  isolation, cross-workspace refusal).
- ✅ **Phone auth** — OTP with peppered hash storage, constant-time comparison,
  attempt caps and single-use consumption; single-use recovery codes; and
  per-destination/per-origin send rate limits. Delivery is a port, so the flow
  is fully tested without a provider account.

- ✅ **A real messaging provider** — Telegram, long-polling so it needs no public
  URL. Browser profiles persist to disk, which the "persistent profiles" line
  above always called for and which was half-built: `saveProfile` wrote a file
  nothing ever read back.

**Remaining:**

- A cloud browser adapter (persistent profiles, live view, session replay).
  The `BrowserProvider` port is stable; this is adapter work behind a vendor
  account. **The only Phase 0 item still open.**

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

**Where those five actually stand:**

| Beat                                          | State                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Book with exact-payload approval              | ✅ Watched end to end, twice                                                                                       |
| **Kill the server mid-task, it finishes**     | ⬜ **The one that does not hold.** DBOS passed its crash-resume spike in Phase 0 and nothing at runtime imports it |
| "Same as last time" from memory               | ◐ Preferences, standing rules and a task ledger all persist and are read; the recall index is not wired            |
| A monitor pings only on a real change         | ✅ Leased, deduped, quiet when nothing changed                                                                     |
| An attacker email refused with an audit entry | ✅ The refusal was always enforced; the chain is now written to as well                                            |

**Also done in v1, and worth naming because none of it was on the list above** —
it only becomes visible once somebody is actually texting the thing: answering
rather than describing what it did · not opening a browser for "Ok" · knowing
what today's date is, enforced at the transport so no caller can forget ·
bounding a task by progress rather than a step count · steering a task
mid-flight · remembering the conversation, up to whatever the model can hold ·
a task that spans the conversation it takes rather than one per message · the
vault reachable, so it can sign in · the audit log actually written to.

**Still open in v1:** the coordinator/worker split (this is one loop over one
task) · coordinator compaction · the dashboard is built and not running ·
per-task forum topics · Gmail (the quarantined reader is built; there is no
OAuth custody) · the live-view handoff · the BYOK settings UI · per-package
builds, so this runs from TypeScript source rather than a compiled artefact.

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
