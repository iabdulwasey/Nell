# Data handling

Nell is designed so you can trust it with real access. This is our commitment,
enforced by the code and verifiable because the trust core is source-available.

## What we never do

- **No training on your data.** Your messages, emails, documents, and vault
  contents are never used to train models.
- **No perpetual license over your content.** You own your data.
- **No silent capture.** No keystroke logging, no silent screen or audio
  capture. On-device capture (e.g. location for a travel task) is opt-in, scoped
  to the task, and never retained silently.

## What we store, and where

- **Vault secrets** — encrypted (AES-256-GCM), only ever decrypted server-side at
  the moment of use.
- **Preferences and task history** — so "book it like last time" works. Visible
  to you and deletable.
- **Derived indexes** (for search over connected-account data) — rebuildable,
  and therefore honestly deletable.

## Deletion is real

Disconnect an integration and Nell runs a durable deletion workflow that removes
the raw synced data **and** the derived indexes, then writes a tombstone to the
audit log and issues you a **deletion receipt**. Revoke means delete — not
"stop syncing but keep what we have."

## Hosted vs self-host

On a self-hosted instance, all of this runs on your own infrastructure with your
own keys. The hosted service adds an operational data-processing agreement and
subprocessor transparency; it never changes the no-training / no-perpetual-license
commitments above.
