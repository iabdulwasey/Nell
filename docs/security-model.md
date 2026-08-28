# Security model

Nell's security is enforced in the tool executor (the policy engine), not in the
prompt. An attack becomes a runtime error, not a persuasion contest.

## The boundaries

1. **Vault.** Secrets are AES-256-GCM encrypted with per-item
   additional-authenticated-data binding (ciphertext can't be swapped across
   items or workspaces), under per-tenant keys wrapped by a KMS-managed key in
   the cloud (or a master key for self-host). Decryption happens only in the
   vault package; values are typed so they can't be serialized into a log.

2. **Secretless autofill.** The model passes only an opaque vault handle and CSS
   selectors. The server decrypts and injects the value directly into the browser
   field. The value never enters the model's context.

3. **Server-side origin allowlist.** Each vault item is pinned to origins the
   user confirmed. At fill time the server checks the browser's _actual_ origin
   (queried over CDP) against the allowlist — the model does not get to name the
   origin.

4. **Typed browser DSL.** Workers act through a typed action vocabulary
   (goto/click/type/select/…), not model-authored code. Arbitrary code on a
   secret-bearing session is an unbounded exfiltration channel, so it does not
   exist. After an autofill the session is tainted: value-returning calls are
   blocked or scrubbed, clipboard/downloads blocked, screenshots masked.

5. **Spend gate.** An approval is a hash of (merchant, items, quantity, options,
   total). The user's confirmation mints a single-use, short-TTL token bound to
   that hash. The purchase call must present a matching token; a changed total
   silently invalidates it. Per-workspace budgets and caps are enforced in the
   same transaction.

6. **Provenance gate.** Third-party content (email bodies, page text, messages
   from strangers) is flagged untrusted. A turn whose new context is
   untrusted-only cannot invoke consequential tools without fresh user
   confirmation. Integrations feed the planner only through quarantined readers
   that emit schema-validated data, never raw prose alongside tool access.

7. **Audit.** Every decrypt, fill, approval, purchase, outbound message, and
   memory deletion is written to an append-only, hash-chained log, visible to the
   user.

8. **Tenant isolation, twice.** Application code filters every query by the
   caller's workspace; PostgreSQL row-level security is the backstop for the
   query that forgets. The request's workspace is published per transaction with
   `SET LOCAL app.workspace_id`, so it cannot leak across a pooled connection.

   **Deployment requirement:** the application's database role must be
   `NOSUPERUSER NOBYPASSRLS`. Superusers ignore RLS entirely — verified against
   PostgreSQL 17, where a superuser connection returned rows from every
   workspace while a correctly-configured role returned only its own and had a
   cross-tenant insert rejected. The app refuses to boot if its role can bypass
   RLS.

## What this buys

The documented failure modes of closed assistants — obeying an injected email,
spending without approval, reading back an autofilled secret, retaining data
after revoke — are each closed here by an architectural boundary, not a
guideline.
