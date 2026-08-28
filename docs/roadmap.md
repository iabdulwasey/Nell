# Roadmap

Phases from scaffold to full platform. Dates are relative; scope is the point.

## Step 1 — Scaffold (this commit)

Git-ready monorepo: package skeleton, licenses, tooling, CI, docs. No trust-core
logic yet. The `DurableEngine` port and the license-key seam exist so later work
drops into the right shape.

## Phase 0 — Trust core

The security foundation, built before any user-facing capability:

- DBOS crash-resume spike (gates the engine choice)
- DB schema + row-level security
- Auth (international OTP, passkeys, recovery)
- Vault: AES-256-GCM envelope encryption + rotation + server-side origin
  allowlists
- `BrowserProvider` (Kernel + local Chromium) with per-workspace ownership and
  persistent profiles
- Typed browser DSL + taint machine
- Policy engine v1 (spend gate, audit writer, rate limits)
- ModelRouter + metering
- `docker compose up` boots everything; eval harness in place

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
