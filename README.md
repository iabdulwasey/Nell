<div align="center">

# Nell

**Open Source Instinct — a personal AI agent you text to get things done.**

Book the table. Buy the tickets. Cancel the subscription. Watch for the drop.
Nell works across your messages, your browser, and your accounts — and asks
before it does anything it can't take back.

_Source-available · self-hostable · your keys, your data · it asks first._

</div>

---

## What Nell is

Text Nell like you'd text a sharp, reliable friend who gets things done:

> **You:** book me a sushi place Friday for 4
> **Nell:** Found 3 near you. Booking Nozomi, 8pm, party of 4 — that's on your
> saved Amex, no cancellation fee. Confirm?
> **You:** yes
> **Nell:** Done ✅ — confirmation #NZ-4471, added to your calendar.

Under the hood Nell drives a real browser, remembers what you like, runs
background monitors ("tell me when a Nobu table opens"), and reaches you on
whatever channel you use — with a permission layer in front of anything that
spends money, sends a message, or touches a credential.

## Why Nell instead of a closed assistant

Closed personal agents ask you to hand over your passwords, your inbox, and your
card, then act silently and hope you trust them. Nell inverts that:

- **Your keys, your data.** Secrets are encrypted before they touch the database
  and are never exposed to the model — you can read the code and verify it.
- **It asks first.** Purchases, message sends, and credential use are gated by
  explicit approval, enforced in code — not by a prompt you hope the model obeys.
- **Untrusted content can't act.** Email and web pages can't quietly instruct the
  agent into doing something you didn't ask for.
- **Honest deletion.** Disconnect an account and its data is actually deleted,
  with a receipt.
- **Self-hostable.** Run the whole thing yourself with one command.

## Quick start (self-host)

```bash
git clone <your-fork-or-this-repo> nell
cd nell
cp .env.example .env   # fill in DATABASE_URL and SECRET_ENCRYPTION_KEY
docker compose up
```

One Postgres, one command, a working personal agent. See
[`docs/`](docs/) for the architecture and self-host guide.

## Licensing — read this

Nell is **source-available (Fair Source)**, not "open source" in the OSI sense —
and we'd rather be upfront about exactly what that means:

- ✅ **Free forever to self-host** for yourself or your company, at any scale.
- ✅ **Fork it, modify it, contribute** — the whole trust core is readable and
  auditable; nothing security-relevant is hidden.
- ✅ **Every version becomes Apache-2.0 open source two years after its release.**
- ❌ **The one thing you can't do:** take Nell and offer it as a hosted service
  that competes with ours, without a commercial license.

The core is licensed under the **Functional Source License (FSL-1.1-Apache-2.0)**
— see [`LICENSE`](LICENSE). The commercial hosting features live under
[`ee/`](ee/) with their own [license](ee/LICENSE) and require a subscription to
run in production; the personal/self-host agent needs none of them.

More detail and a full FAQ:
[`docs/adr/0002-licensing-open-core.md`](docs/adr/0002-licensing-open-core.md).

## Status

**Under active development — the trust core is built, the agent is not yet.**
Not usable as a personal assistant today.

What exists and is tested (119 tests, all packages typechecking):

| Component                                                                 | State   |
| ------------------------------------------------------------------------- | ------- |
| Encrypted vault (AES-256-GCM, per-item binding, key rotation)             | ✅      |
| Policy engine — spend approvals, origin allowlist, taint, provenance gate | ✅      |
| Append-only hash-chained audit log                                        | ✅      |
| Durable execution — crash-resume verified on real Postgres                | ✅      |
| Tenant isolation — row-level security verified on PostgreSQL 17           | ✅      |
| Typed browser action DSL (no code-execution escape hatch)                 | ✅      |
| Model router with cost metering and circuit breaker                       | ✅      |
| Anti-cheat eval harness with adversarial refusal scenarios                | ✅      |
| `docker compose up` — Postgres + core service with health endpoints       | ✅      |
| Browser adapters, agent runtime, channels, dashboard, memory              | 🚧 next |

The security foundation is deliberately built first: every boundary that
protects your money and credentials is enforced in code and covered by tests
before any capability is layered on top. See [`docs/roadmap.md`](docs/roadmap.md)
for what lands when, and [`docs/security-model.md`](docs/security-model.md) for
how the boundaries work.

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Found a vulnerability? Please follow [`SECURITY.md`](SECURITY.md) — do not open a
public issue.
