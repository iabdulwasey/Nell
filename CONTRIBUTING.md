# Contributing to Nell

Thanks for your interest in Nell. A few things to know before you open a PR.

## Two licenses, one repo

- Everything **outside `ee/`** is licensed under the Functional Source License
  (see [`LICENSE`](LICENSE)). This is the community core.
- Everything **inside `ee/`** is the commercial Enterprise Edition (see
  [`ee/LICENSE`](ee/LICENSE)). You may read, modify, and test it, but it may only
  run in production under a Nell subscription.

New top-level code defaults to the FSL core. If your change belongs in `ee/`,
say so in the PR description.

## Contributor License Agreement

By contributing you agree to our CLA/DCO: you grant the project maintainer
(Abdul Wasey) the rights needed to distribute your contribution under the
project's licenses and to honor the Apache-2.0 future-license conversion. A bot
will prompt you on your first PR.

## Ground rules for the trust core

The security of Nell is enforced in code, not prompts. When touching
`packages/vault`, `packages/aegis`, `packages/browser`, `packages/audit`, or
`packages/channels`:

- Never let a secret value reach the model. The model gets opaque handles only.
- Never add a dependency with a copyleft license (GPL/LGPL/AGPL/SSPL) — CI will
  reject it.
- Consequential actions (spend, send, credential use) go through the policy
  engine; do not add a code path that bypasses it.

## Development

```bash
pnpm install
pnpm check     # typecheck + lint + tests + format + license audit
pnpm build
```

## Code style

oxlint + oxfmt, strict TypeScript. Run `pnpm lint:fix` and `pnpm format` before
pushing.
