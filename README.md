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
  ADDING A VIDEO HERE
  -------------------
  Two constraints, both of which will silently reject an upload:

    Size    10MB for a repo on a free plan (100MB only on paid). This is the
            one that bites — a 20-second phone screen recording is comfortably
            over it untouched.
    Format  .mp4, .mov or .webm, and GitHub recommends H.264 for browser
            compatibility. iPhone recordings are HEVC by default.

  To get a recording under the limit without losing readability:

    ffmpeg -i in.mov -vf "scale=-2:1280" -c:v libx264 -pix_fmt yuv420p \
           -crf 26 -preset slow -movflags +faststart -c:a aac -b:a 96k out.mp4

  CRF targets a quality rather than a size, which is why it works so well on a
  screen recording: almost nothing moves between frames, so it spends very few
  bits. Twenty seconds lands around 6MB at full phone resolution. Raise the CRF
  toward 30 for smaller, drop `-c:a aac -b:a 96k` entirely if the clip is silent.

  Then: drag the file into any issue comment box on this repo, wait for the
  upload to finish, and copy the https://github.com/user-attachments/assets/...
  URL it leaves behind. The comment does not need to be posted — the upload is
  already permanent. Put that URL on its own line and GitHub renders a player.
-->

<!--
  Side by side needs an HTML table and explicit <video> tags. A bare
  user-attachments URL becomes a player only in plain markdown, on its own line;
  inside HTML that conversion does not happen and you get a dead link. GitHub's
  sanitiser does allow <video src controls>, which is what makes this work.
-->
<table>
<tr>
<td width="50%" valign="top">

**Booking a cinema ticket**

<video src="https://github.com/user-attachments/assets/2c5e5e99-9fda-48d8-a238-1a214c8a2926" controls></video>

One message. Nell finds the cinema, opens the film, picks the seats — and stops
where the money starts.

</td>
<td width="50%" valign="top">

**Planning a holiday**

<video src="https://github.com/user-attachments/assets/1b72c5d2-a170-438b-9309-22756cb51ff2" controls></video>

Four questions in one sentence — flights, stay, places, activities. It answers
each rather than finding one page that mentions the subject.

</td>
</tr>
</table>

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

**It runs.** You can text it, and it does the thing — the video above is a real
task on a real browser, driven by a real model, with the results in a real
Postgres. Self-hosting it needs a Telegram bot token, a model key and a
Postgres, and nothing else.

What that sentence does not cover, and it is a lot: this is one agent working
one task at a time on one machine. There is no hosted service, no coordinator
splitting work across tasks, no cloud browser, and every vendor beyond the
model and search is still an unbound port. The list below is honest about which
side of that line each piece falls on.

**1,156 tests · 57 adversarial attacks run on every commit · CI green.**

### Built and tested

| Area                      | What exists                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Vault**                 | AES-256-GCM, per-item AAD binding, key rotation, `Secret<T>` that redacts itself, CVC never stored                    |
| **Policy chokepoint**     | One executor both perception modes pass through — a pixel click meets the same gates as a targeted one                |
| **Spend**                 | A click that commits money is refused at the chokepoint until you say yes — pixel clicks included                     |
| **Approvals**             | Bound to what you were shown: single-use, and consent for £18.50 is not consent for £95.00                            |
| **Virtual cards**         | Single-use card per purchase, capped at the approved total — a limit the card network enforces, not our code          |
| **Untrusted content**     | Provenance gate + quarantined readers; a turn whose only new context is email or web text cannot act                  |
| **2FA**                   | Vaulted TOTP (verified against RFC 6238 vectors) and per-use scoped code reads that return digits and nothing else    |
| **Credentials on a page** | Taint machine blocks field reads, clipboard, uploads and downloads; captures are masked before the PNG is encoded     |
| **Audit**                 | Append-only hash chain, verified on every render rather than behind a button                                          |
| **Deletion**              | Derived data is rebuildable, so deleting a source provably removes every copy — with a receipt                        |
| **The computer**          | One machine per user, profile kept on disk — logins survive a restart, so the vault is rarely touched at all          |
| **Computer use**          | Full pointer/keyboard surface mirroring the Anthropic and OpenAI tool schemas, plus an accessibility-tree fast path   |
| **Handoff**               | A short-lived, single-use link that hands you the controls for a CAPTCHA or 3DS — and stops the agent while you drive |
| **Memory**                | Preferences, task ledger, directives, reviewed playbooks, and a derived recall index                                  |
| **Channels**              | Telegram (per-task forum topics), WhatsApp (24-hour service window), iMessage (STOP/START/HELP, per-task groups)      |
| **Models**                | Bring your own: Anthropic, OpenAI, Google, xAI, DeepSeek, GLM, Kimi, Mistral, OpenRouter, or your own hardware        |
| **Dashboard**             | Tasks, approvals, machine, vault, memory, audit, model settings                                                       |
| **Durability**            | DBOS crash-resume verified against real Postgres; RLS tenant isolation verified on PostgreSQL 17                      |
| **Two senses**            | Accessibility tree for speed; when it stops learning anything the agent switches to looking at the screen             |
| **Search**                | Bound to a live vendor — search engines captcha a headless browser, so searching is not something to do in one        |
| **Knowing you**           | Asks once where you are, then never again; share a pin on Telegram and it takes that                                  |
| **Recurring work**        | "Every morning at 6, scan the AI news" — leased, deduped, and it stays quiet when nothing changed                     |
| **Bounds**                | A task runs while it is getting somewhere and stops when it is not; going round in circles counts as standing still   |

Some of the above is tested but not yet reachable from a chat message — the
vault, virtual cards, TOTP, the audit chain, the handoff link and the dashboard
all work and are covered, and nothing in the running agent calls them yet. They
are listed here because the boundaries are real, not because you can use them
today.

The spend gate was in that list until recently, and it is worth saying what
changed. The approval machinery had been built and tested since Phase 0 and
nothing in the agent ever called it: what actually stopped a live booking at the
payment page was the model saying it should stop. That is obedience, and this
project's whole claim is that it does not rely on obedience. A click that
commits money now meets the gate before it reaches the page — through either
sense, since a gate covering only one is a gate the agent walks around by
changing how it sees.

### Not built yet

Voice calls · Calendar, Slack, Notion, Linear, GitHub and MCP connectors · email
write operations · cloud-browser vendor adapter · the desktop companion · hosted
billing · a coordinator that runs more than one task at a time.

The security foundation is deliberately built first: every boundary that protects
your money and your credentials is enforced in code and covered by tests before
any capability is layered on top.

The adversarial suite is worth a look if you are evaluating the trust story —
[`packages/evals/src/attacks.ts`](packages/evals/src/attacks.ts) runs 57 real
attacks against the real gates on every commit, and each one records the incident
or hazard it guards against. Run it with `pnpm attacks`.

See [`docs/security-model.md`](docs/security-model.md) for how the boundaries
work and [`docs/roadmap.md`](docs/roadmap.md) for what lands when.

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Security

Found a vulnerability? Please follow [`SECURITY.md`](SECURITY.md) — do not open a
public issue.
