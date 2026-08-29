<div align="center">

# Nell (Open Source Instinct)

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

## See it work

<!--
  HOW TO FILL THESE IN
  --------------------
  GitHub only plays video inline when the file is hosted on GitHub itself.
  A link to Drive, Dropbox or a raw file in this repo will not play.

    1. Open any issue or pull-request comment box on this repo
       (https://github.com/iabdulwasey/Nell/issues/new).
    2. Drag the .mp4 or .mov into the box and wait for the upload to finish.
       GitHub replaces it with a URL like
       https://github.com/user-attachments/assets/xxxxxxxx-xxxx-xxxx
    3. Copy that URL. Close the issue box WITHOUT posting — the upload is
       already permanent and does not need the comment.
    4. Replace the placeholder URL below with it, on its own line.
       A bare user-attachments URL on its own line renders as a player.

  Keep each clip short and silent-friendly: most people watch a README video
  muted, on the first pass, before they have read a word of the text.
-->

### Booking something, end to end

<!-- Replace this line with the user-attachments URL for the first video. -->

_Nell finds a showing, picks the seats, and stops at the approval — the purchase
is the one thing it will not do on its own._

### Answering from the live web

<!-- Replace this line with the user-attachments URL for the second video. -->

_A question goes in on Telegram; Nell searches, reads the pages, and comes back
with the answer rather than a description of where it got to._

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

**The substrate is built and tested; it is not yet a running assistant.** Every
boundary below is enforced in code and covered by tests, but nothing is wired to
a live model, a cloud browser, or a real phone number yet — so it is not
something you can text today.

**812 tests · 41 adversarial attacks run on every commit · CI green.**

### Built and tested

| Area                      | What exists                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Vault**                 | AES-256-GCM, per-item AAD binding, key rotation, `Secret<T>` that redacts itself, CVC never stored                    |
| **Policy chokepoint**     | One executor both perception modes pass through — a pixel click meets the same gates as a targeted one                |
| **Spend**                 | Approvals bound to a payload hash: single-use, short-TTL, invalidated by any change to items, options or total        |
| **Virtual cards**         | Single-use card per purchase, capped at the approved total — a limit the card network enforces, not our code          |
| **Untrusted content**     | Provenance gate + quarantined readers; a turn whose only new context is email or web text cannot act                  |
| **2FA**                   | Vaulted TOTP (verified against RFC 6238 vectors) and per-use scoped code reads that return digits and nothing else    |
| **Credentials on a page** | Taint machine blocks field reads, clipboard, uploads and downloads; captures are masked before the PNG is encoded     |
| **Audit**                 | Append-only hash chain, verified on every render rather than behind a button                                          |
| **Deletion**              | Derived data is rebuildable, so deleting a source provably removes every copy — with a receipt                        |
| **The computer**          | One persistent machine per user: logins survive, so the vault is rarely touched at all                                |
| **Computer use**          | Full pointer/keyboard surface mirroring the Anthropic and OpenAI tool schemas, plus an accessibility-tree fast path   |
| **Handoff**               | A short-lived, single-use link that hands you the controls for a CAPTCHA or 3DS — and stops the agent while you drive |
| **Memory**                | Preferences, task ledger, directives, reviewed playbooks, and a derived recall index                                  |
| **Channels**              | Telegram (per-task forum topics), WhatsApp (24-hour service window), iMessage (STOP/START/HELP, per-task groups)      |
| **Models**                | Bring your own: Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Mistral, OpenRouter, or your own hardware        |
| **Dashboard**             | Tasks, approvals, machine, vault, memory, audit, model settings                                                       |
| **Durability**            | DBOS crash-resume verified against real Postgres; RLS tenant isolation verified on PostgreSQL 17                      |

### Not built yet

Voice calls · Calendar, Slack, Notion, Linear, GitHub and MCP connectors · email
write operations · cloud-browser vendor adapter · the desktop companion · hosted
billing.

The security foundation is deliberately built first: every boundary that protects
your money and your credentials is enforced in code and covered by tests before
any capability is layered on top.

The adversarial suite is worth a look if you are evaluating the trust story —
[`packages/evals/src/attacks.ts`](packages/evals/src/attacks.ts) runs 41 real
attacks against the real gates on every commit, and each one records the incident
or hazard it guards against. Run it with `pnpm attacks`.

See [`docs/security-model.md`](docs/security-model.md) for how the boundaries
work and [`docs/roadmap.md`](docs/roadmap.md) for what lands when.

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Found a vulnerability? Please follow [`SECURITY.md`](SECURITY.md) — do not open a
public issue.
