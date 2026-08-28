# Security Policy

Nell handles credentials, payment details, and account access. We take security
seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, report privately via GitHub's "Report a vulnerability" (Security →
Advisories) on this repository, or email the maintainer. We aim to acknowledge
within 72 hours and to keep you updated as we investigate and fix.

## Scope

Of particular interest:

- Any path by which a secret value reaches the model or a log.
- Any way untrusted content (email, web page, inbound message) can trigger a
  consequential action (spend, send, credential use) without user approval.
- Any bypass of the policy engine, the vault origin allowlist, or the spend
  approval gate.
- Any cross-tenant data access.

## Safe harbor

We will not pursue action against good-faith security research that respects user
privacy, avoids data destruction, and gives us reasonable time to remediate
before public disclosure.
