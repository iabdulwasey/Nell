# ADR 0002 — Licensing: source-available open core

**Status:** Accepted (2026-08-29)

## Context

Nell must be genuinely usable and auditable when self-hosted — that openness is
what earns trust and adoption — while remaining a viable business. The failure
modes to avoid are both real: fully-permissive personal-agent projects have gone
viral and captured no commercial value, while fully-closed ones captured value
but lost user trust. Nell aims to win both.

## Decision

**Source-available open core**, with two licenses in one public repository.

### Core — Functional Source License (FSL-1.1-Apache-2.0)

Everything outside `ee/` is under the FSL (see [`/LICENSE`](../../LICENSE)):

- Free to self-host for personal **and** internal-company use, at any scale.
- Free to fork, modify, and contribute.
- The only prohibition is **Competing Use** — offering Nell as a hosted service
  that competes with ours, without a commercial license.
- **Each version auto-converts to Apache-2.0 two years after its release** — so
  it genuinely becomes OSI open source on a clock.

Chosen over BUSL (internal-use-at-scale not guaranteed without a hand-drafted
grant; 4-year delay), over ELv2/PolyForm (never convert), and over a bespoke
license (procurement friction). FSL is a named, recognized license and the
cleanest fit for "free self-host including internal use, no reselling as a
service."

### Commercial — Nell Enterprise Edition License

Everything under `ee/` is commercial (see [`/ee/LICENSE`](../../ee/LICENSE)):
billing, multi-tenant control plane, virtual-card issuing, referral/waitlist
admission. It is **source-visible** (readable, buildable, testable — a dev/test
carve-out) but may only run in production under a subscription, and is
**runtime-gated by a signed license key**. The EE license makes circumventing the
key check or removing attribution an explicit violation.

## Enforcement

- **Signed keys, not booleans.** License keys are signed Ed25519 certs. The
  distribution ships the public key (`packages/license`) and verifies signatures
  locally; the private signing key lives only in `ee/license-server/`, which is
  **not** in this repo.
- **Fail-soft.** No/invalid key → the gated `ee/` feature is simply unavailable;
  the FSL core keeps running perfectly. A missing key never breaks self-host.
- **Honest, not obfuscated.** The check is in readable source. Enforcement is
  legal (the EE license + a signed cert make bypass willful infringement), not
  DRM. The people who would pay won't ship a patched check; the people who would
  patch it were never going to pay.
- **Contributions:** a CLA/DCO preserves the right to dual-license and to honor
  the Apache-2.0 conversion.

## Naming rule

Describe Nell as **"source-available"** or **"Fair Source,"** never "open
source," until each version converts. Lead with the trust-and-free-self-host
story; state the one commercial restriction plainly.

## Licensing FAQ

**Is it free?** Yes — free forever to self-host for yourself or your company, at
any scale.

**Can I fork and modify it?** Yes, and contribute back.

**What can't I do?** Offer Nell as a hosted service that competes with ours,
without a commercial license.

**Does it ever become "real" open source?** Yes — every version becomes
Apache-2.0 two years after its release.

**Is the security-critical code hidden?** No. The entire trust core (vault,
policy engine, browser, audit, channels) is source-available and auditable.
