# ADR 0003 — Browser perception: structured-first, pixels as escalation

**Status:** Accepted (2026-08-29)

## Context

An agent that books, buys and fills forms needs to perceive and act on pages.
Two approaches were seriously considered:

1. **Computer use** — screenshots plus mouse/keyboard coordinates, as the
   frontier computer-use models offer. Its appeal is completeness: with a real
   machine it can do anything a human can, including OS-native dialogs.
2. **Structured-first** — a filtered accessibility snapshot with stable element
   references, escalating to pixels when structure is insufficient.

The question was raised sharply: if computer use can do everything, why not make
it the default and avoid ever hitting a capability wall?

## Decision

**Structured-first is the default. Pixels are an in-session escalation on the
same page, never a separate agent and never the default.** Full desktop computer
use is a third tier that v1 does not ship.

## Why, in order of weight

**1. Failure mode, not capability.** A version-stamped ref that goes stale
raises `StaleRefError`. A stale coordinate clicks whatever moved into that
position — silently. Published work puts silent coordinate failure on UI change
around 90%. For an agent that spends money, a caught error beats a wrong
purchase, and this difference does not narrow as models improve.

**2. Latency.** Measured DOM-first agents complete a task in ~68s; pixel-driven
ones take ~285-330s. Nell's promise is a fast reply from something that feels
like a sharp friend. Four extra minutes of silence is a materially worse
product, independent of what it costs us.

**3. Accuracy no longer decides it.** On identical tasks and models,
ComponentBench measured 83.8% pixel against 81.5% accessibility-tree. That gap
is too narrow to carry the decision either way, which is precisely why the
argument rests on failure mode and latency instead.

**4. The vendor built the hybrid.** Anthropic's `browser_toolset_20260801`
exposes `read_page` (accessibility tree with `[ref_N]` handles) _and_
`screenshot`/`zoom`, with interchangeable ref and coordinate targets. The model
provider did not bet on pixels alone.

## What this explicitly does not claim

An earlier 45x cost figure was cited in support of structured-first. It compared
an unbatched pixel loop against a batched structured one and does not reproduce
against current tooling — batched against batched it is closer to 2-3x on
tokens. The cost advantage is real but second-order, and the architecture should
not be defended with a number that will not survive scrutiny.

## File upload — the case that prompted this

Upload is handled **structurally, never through pixels**. Playwright's
`setInputFiles` (CDP `DOM.setFileInputFiles`) writes the FileList onto the
element and fires `change`; no OS dialog is summoned in any mode. Fallbacks are
a `filechooser` waiter armed before the click, then a synthesized `DataTransfer`
drop for drop-only zones.

The pixel route is the one that fails here: teams driving native pickers by
coordinate report the dialog appearing and being impossible to dismiss
programmatically. This is verified in our own test suite — a real Chromium
receives a real FileList with the correct name and byte count, with no dialog.

**Download-then-upload** (fetch a CV from a link, attach it to a form) is four
typed actions with a `FileBroker` mediating: `stage()` resolves an opaque
reference into the session's upload directory, `capture()` writes downloads into
a separate directory. Two directories, never one — a page that can steer an
upload must not reach a file it just caused to be downloaded. Workers name
references, never paths, or `upload` becomes an arbitrary-file-read primitive.

## Escalation triggers

`stale-ref`, `repeated-failure` (2 consecutive), `silent-no-op` (action reported
success but URL, snapshot hash and DOM version are unchanged — a failure a pixel
agent cannot even detect), `opaque-content`, `dialog-suspected` (the
accessibility tree does not model z-order or occlusion), `visual-task`, and a
mandatory `verification-checkpoint` screenshot immediately before any
consequential action. That last one is a product requirement: the human approves
against a picture of the real page, not the agent's prose.

De-escalation is mandatory — after any successful coordinate action, take a
fresh snapshot and return to structured mode, so a task cannot drift permanently
into pixel mode.

## Environment

Persistence is the **profile, not the machine**: per-user, per-merchant cookie
and login state, with pooled suspend/resume sessions. An always-on VM per user
is not a cost optimisation question — it is 730 hours of billed compute per user
per month to serve a few hours of actual work.

## Revisit when

Nell's own telemetry shows structured-first losing on **booking-completion
rate** — not on cost, and not on a benchmark. That is the only signal that
should reopen this.
