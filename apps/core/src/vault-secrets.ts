/**
 * The vault, connected to the browser.
 *
 * Two functions, and the split between them is the security property. One says
 * *what exists* for the site the browser is on — labels and opaque ids, never a
 * value, safe to put in a model's prompt. The other turns an id and a field name
 * into a string that gets typed, and it is the only thing here that can produce
 * plaintext.
 *
 * Both take the origin from the live session. Neither takes it from the model,
 * and there is no parameter either could be persuaded through: the argument
 * arrives from `page.url()` by way of the executor, so a page insisting it is the
 * bank changes what the model *believes* and nothing about what it gets.
 */

import type { SecretSource } from "@nell/aegis";
import type { AccessScope } from "@nell/shared";
import { totpAt, type KeyProvider } from "@nell/vault";
import type { Pool } from "pg";
import { withWorkspace } from "./db.js";
import { itemsForOrigin, revealForOrigin, type VaultItemSummary } from "./vault-store.js";

/** What the agent may be told about a credential: everything but the credential. */
export interface CredentialOffer {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly accountHint?: string;
}

export interface VaultAccess {
  /** Items usable on the page the browser is actually on. Never values. */
  readonly offers: (scope: AccessScope, origin: string) => Promise<readonly CredentialOffer[]>;
  readonly secrets: SecretSource;
  /** The account this person signs in with, if they have told us once already. */
  readonly knownAccount: (scope: AccessScope) => Promise<string | undefined>;
}

/**
 * Wire the vault to a database and a key.
 *
 * A single object rather than two exports, because handing the executor a
 * `SecretSource` while the loop reads its listing from somewhere else is how the
 * two drift — the agent offering an item the executor will then refuse, or the
 * reverse. Same pool, same keys, same origin check underneath both.
 */
export function vaultAccess(pool: Pool, keys: KeyProvider): VaultAccess {
  return {
    offers: async (scope, origin) => {
      const items = await withWorkspace(pool, scope, (client) =>
        itemsForOrigin(client, scope, origin)
      );
      return items.map(summarise);
    },

    /**
     * The email the person actually uses, inferred from what they have already
     * saved rather than asked for again.
     *
     * The vault turns out to be the best place to look. Somebody with three
     * logins stored has told us their email three times; the most repeated
     * `accountHint` is that email with far better odds than anything a model
     * could guess, and it costs one query and no new data to collect. A first
     * credential has nothing to go on and the field is simply blank, which is
     * the correct answer rather than a failure.
     *
     * Ties break towards the most recently saved — people change address, and
     * the newer one is the one they are still reading.
     */
    knownAccount: async (scope) => {
      /**
       * Its own query rather than `listItems`, which orders by label — and
       * "most used, then most recent" cannot be computed from an alphabetical
       * list. Reads one non-secret column, so it widens nothing: `account_hint`
       * is already what the agent is shown.
       */
      const { rows } = await withWorkspace(pool, scope, (client) =>
        client.query<{ account_hint: string }>(
          `SELECT account_hint
             FROM vault_items
            WHERE workspace_id = $1 AND account_hint IS NOT NULL AND account_hint <> ''
            GROUP BY account_hint
            ORDER BY count(*) DESC, max(updated_at) DESC
            LIMIT 1`,
          [scope.workspaceId]
        )
      );
      return rows[0]?.account_hint;
    },

    secrets: {
      reveal: async (scope, itemId, actualOrigin, field) => {
        const outcome = await withWorkspace(pool, scope, (client) =>
          revealForOrigin(client, scope, keys, itemId, actualOrigin)
        );
        if (!outcome.ok) return outcome;

        /**
         * The plaintext exists from here to the return, and no further.
         *
         * `expose()` is deliberately awkward to call — it is the moment a
         * `Secret<string>` stops protecting anything — so it is called once,
         * parsed, and the field taken. Nothing is logged in this function and
         * nothing is thrown with the value in it: an error message is the most
         * common way a password ends up in a log file.
         */
        let stored: unknown;
        try {
          stored = JSON.parse(outcome.value.expose());
        } catch {
          return { ok: false, reason: "That vault item is stored in a form I cannot read." };
        }

        return fieldOf(stored, field);
      },
    },
  };
}

function summarise(item: VaultItemSummary): CredentialOffer {
  return {
    id: item.id,
    kind: item.kind,
    label: item.label,
    ...(item.accountHint ? { accountHint: item.accountHint } : {}),
  };
}

type FieldOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * One field out of a stored item.
 *
 * The DSL's field names are deliberately generic — `username`, `password`,
 * `number`, `name` — so the model describes what a form wants rather than
 * knowing how anything is stored. This is where that vocabulary meets the actual
 * shapes, and an unmapped combination is refused rather than guessed at: filling
 * a password field with a cardholder name is the kind of mistake that gets typed
 * into a page and submitted before anyone notices.
 */
function fieldOf(stored: unknown, field: string): FieldOutcome {
  const item = stored as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const value = item[key];
    return typeof value === "string" && value ? value : undefined;
  };

  switch (field) {
    case "username":
      return present(text("username") ?? text("email"), "a username");

    case "password":
      return present(text("password"), "a password");

    /**
     * The second factor, computed here and never stored anywhere else.
     *
     * This is the part that removes an attack rather than guarding one. The
     * alternative — reading the code out of an inbox — means opening a mailbox
     * full of text an attacker can write into, at exactly the moment the agent
     * is trying to log in. A seed in the vault means no inbox is involved: six
     * digits are computed from a number nobody sent us.
     *
     * The seed itself never leaves this function, and could not be typed into a
     * page even by a model that asked for it — there is no field name for it.
     */
    case "totp": {
      const seed = text("totpSecret");
      if (!seed) return { ok: false, reason: "That login has no second-factor seed stored." };
      try {
        return { ok: true, value: totpAt({ secret: seed }, Date.now()) };
      } catch {
        return { ok: false, reason: "That second-factor seed is not valid base32." };
      }
    }

    case "number":
      return present(text("number") ?? text("e164"), "a number");

    case "expiry": {
      const month = item["expiryMonth"];
      const year = item["expiryYear"];
      if (typeof month !== "number" || typeof year !== "number") {
        return { ok: false, reason: "That item has no expiry stored." };
      }
      // MM/YY — what a card form asks for. A four-digit year in a two-digit box
      // is silently truncated by some sites and rejected by others.
      return { ok: true, value: `${String(month).padStart(2, "0")}/${String(year % 100)}` };
    }

    case "name":
      return present(text("cardholderName") ?? text("legalName"), "a name");

    /** For items that are a single value: a phone number, an address line. */
    case "value":
      return present(text("e164") ?? text("line1") ?? text("value"), "a value");

    default:
      return { ok: false, reason: `I cannot fill "${field}" from a stored item.` };
  }
}

function present(value: string | undefined, what: string): FieldOutcome {
  return value ? { ok: true, value } : { ok: false, reason: `That item does not have ${what}.` };
}
