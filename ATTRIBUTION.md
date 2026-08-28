# Attribution

Nell is built by Abdul Wasey. This file credits the third-party projects and
services Nell builds on.

## Infrastructure and ecosystem

Nell builds on, and is grateful to, the following projects and services:

- **DBOS Transact** — durable execution (MIT)
- **Kernel** — cloud browser automation
- **Linq** — iMessage / messaging gateway
- **Hono**, **Next.js**, **Drizzle ORM**, **Zod**, **Vercel AI SDK**,
  **Better Auth**, **Nango**, **Playwright**, **pgvector** — and the wider
  TypeScript and Postgres ecosystems.

Full third-party license texts are listed in `THIRD_PARTY_NOTICES.md`.

## Design

Nell's security model — an encrypted vault (AES-256-GCM with per-item
additional-authenticated-data binding) and secretless browser autofill (the
model receives only opaque handles; secrets are injected server-side and never
enter the model's context) — follows established applied-cryptography and
agent-safety practice.
