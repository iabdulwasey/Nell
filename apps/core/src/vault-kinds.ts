/**
 * The four things a vault holds, described once.
 *
 * Logins, addresses, cards and phones — the same four the vaults this was
 * modelled on settled on, and for the same reason: they are what a checkout or
 * an intake form asks for. Anything else is a note, not a credential.
 *
 * Each kind is described in one place — the fields, their labels, how a
 * submission becomes a stored item — because the alternative is a form with a
 * field the save ignores. That failure is silent and permanent: the person
 * typed their county into a box, saw "Saved", and the county is not there.
 *
 * **The one structural decision worth stating.** An address is *structured* —
 * line1, city, region, postcode, country as separate fields, not one blob. The
 * vault this design learned from stores addresses as a single free-text string,
 * and its own audit records the consequence: a multi-field checkout cannot be
 * filled from it, because there is no way to answer "what goes in the City box".
 * Splitting it later means asking every user to retype every address, which is
 * why it is split now.
 */

import { originBound, type VaultItemKind } from "@nell/vault";

export interface VaultField {
  readonly name: string;
  readonly label: string;
  /** Rendered as a password box, and never prefilled. */
  readonly secret?: boolean;
  readonly required?: boolean;
  readonly hint?: string;
  readonly placeholder?: string;
}

export interface SavedItem {
  readonly label: string;
  /** Non-secret, shown in listings — an email, or "Visa ending 4242". */
  readonly accountHint?: string;
  readonly origins: readonly string[];
  /** The JSON that gets encrypted. */
  readonly value: Record<string, unknown>;
}

export interface VaultKindForm {
  readonly kind: VaultItemKind;
  /** What the section is called: "Logins". */
  readonly section: string;
  /** What one of them is called: "login". */
  readonly one: string;
  readonly fields: readonly VaultField[];
  /** A note under the form, when there is something the person should know. */
  readonly note?: string;
  /**
   * Turn a submission into a stored item, or say what is missing.
   *
   * Returning the reason rather than throwing, because "you left the postcode
   * out" is an ordinary thing for a person to do and should re-render the form
   * with what they typed still in it.
   */
  readonly build: (
    read: (name: string) => string,
    origin: string
  ) =>
    | { readonly ok: true; readonly item: SavedItem }
    | { readonly ok: false; readonly why: string };
}

/** The kind a URL asked for, or the default. Never trusts the string. */
export function formFor(kind: string | null | undefined): VaultKindForm {
  return FORMS.find((form) => form.kind === kind) ?? FORMS[0]!;
}

export const FORMS: readonly VaultKindForm[] = [
  {
    kind: "login",
    section: "Logins",
    one: "login",
    /**
     * Name, username, password — the three a person actually has to type.
     *
     * The site is not among them by design: at a sign-in wall it comes from the
     * browser's live URL, so the form opens already bound to the right place.
     * It is only asked for when someone adds a login out of the blue, and even
     * then it is asked for rather than inferred, because a password bound to the
     * wrong site is the one mistake here that matters.
     *
     * The second factor is last and optional. Storing the seed means Nell can
     * compute the code itself and never open a mailbox to find one — which
     * removes the channel an attacker writes into rather than guarding it.
     */
    fields: [
      { name: "label", label: "Name", placeholder: "Airline", required: true },
      { name: "username", label: "Username or email", required: true },
      { name: "password", label: "Password", secret: true, required: true },
      {
        name: "totp",
        label: "Two-factor seed",
        hint: "optional — the long code shown beside the QR",
        placeholder: "JBSWY3DPEHPK3PXP",
      },
    ],
    note:
      "Tied to this site only. Nell will not offer it anywhere else, whatever a page " +
      "claims to be — and it is typed into the form by the browser, never shown to the model.",
    build: (read, origin) => {
      const username = read("username");
      const password = read("password");
      if (!origin) return { ok: false, why: "Which site is this login for?" };
      if (!username || !password)
        return { ok: false, why: "A username and a password are needed." };

      const totp = read("totp").replaceAll(/\s/gu, "").toUpperCase();
      return {
        ok: true,
        item: {
          label: read("label") || hostOf(origin) || "Login",
          accountHint: username,
          origins: [origin],
          value: {
            kind: "login",
            username,
            password,
            ...(totp ? { totpSecret: totp } : {}),
            origins: [origin],
          },
        },
      };
    },
  },

  {
    kind: "address",
    section: "Addresses",
    one: "address",
    fields: [
      { name: "label", label: "Name", placeholder: "Home", required: true },
      { name: "line1", label: "Address line 1", required: true },
      { name: "line2", label: "Address line 2", hint: "optional" },
      { name: "city", label: "City", required: true },
      { name: "region", label: "State or county", hint: "optional" },
      { name: "postalCode", label: "Postcode", required: true },
      { name: "country", label: "Country", placeholder: "GB", required: true },
    ],
    note:
      "Kept as separate fields rather than one block of text, so a checkout that asks " +
      "for city and postcode in different boxes can actually be filled in.",
    build: (read) => {
      const line1 = read("line1");
      const city = read("city");
      const postalCode = read("postalCode");
      const country = read("country").toUpperCase();
      if (!line1 || !city || !postalCode) {
        return { ok: false, why: "An address needs at least a first line, a city and a postcode." };
      }
      if (country.length !== 2) {
        return { ok: false, why: "Country should be the two-letter code — GB, US, IN." };
      }

      const line2 = read("line2");
      const region = read("region");
      return {
        ok: true,
        item: {
          label: read("label") || "Address",
          accountHint: `${line1}, ${city}`,
          // Not site-scoped: an address is filled in wherever it is asked for.
          origins: [],
          value: {
            kind: "address",
            line1,
            ...(line2 ? { line2 } : {}),
            city,
            ...(region ? { region } : {}),
            postalCode,
            country,
          },
        },
      };
    },
  },

  {
    kind: "payment",
    section: "Cards",
    one: "card",
    /**
     * No security code, and it is not an omission.
     *
     * PCI DSS forbids keeping a CVC after authorisation, and nothing here needs
     * one: when a merchant asks, the person supplies it at that moment. The
     * happy consequence is that a card number lifted from a page is largely
     * unusable on its own — which is most of why a card can be unscoped without
     * being unsafe.
     */
    fields: [
      { name: "label", label: "Name", placeholder: "Everyday card", required: true },
      { name: "cardholderName", label: "Name on card", required: true },
      { name: "number", label: "Card number", secret: true, required: true },
      { name: "expiryMonth", label: "Expiry month", placeholder: "09", required: true },
      { name: "expiryYear", label: "Expiry year", placeholder: "2029", required: true },
      { name: "billingPostalCode", label: "Billing postcode", required: true },
    ],
    note:
      "The security code is never stored — that is a rule, not a missing feature. " +
      "You supply it at the moment a shop asks. Nothing is ever bought without asking you first.",
    build: (read) => {
      const number = read("number").replaceAll(/[\s-]/gu, "");
      const cardholderName = read("cardholderName");
      const billingPostalCode = read("billingPostalCode");
      const expiryMonth = Number(read("expiryMonth"));
      const expiryYear = Number(read("expiryYear"));

      if (!/^\d{12,19}$/u.test(number)) {
        return { ok: false, why: "A card number is 12 to 19 digits." };
      }
      if (!Number.isInteger(expiryMonth) || expiryMonth < 1 || expiryMonth > 12) {
        return { ok: false, why: "Expiry month should be 1 to 12." };
      }
      if (!Number.isInteger(expiryYear) || expiryYear < 2024 || expiryYear > 2100) {
        return { ok: false, why: "Expiry year should be the full year — 2029." };
      }
      if (!cardholderName || !billingPostalCode) {
        return { ok: false, why: "The name on the card and the billing postcode are needed." };
      }

      return {
        ok: true,
        item: {
          label: read("label") || "Card",
          // The last four only. Enough to tell two cards apart, useless to
          // anyone who reads it.
          accountHint: `ending ${number.slice(-4)}`,
          origins: [],
          value: {
            kind: "payment",
            cardholderName,
            number,
            expiryMonth,
            expiryYear,
            billingPostalCode,
          },
        },
      };
    },
  },

  {
    kind: "phone",
    section: "Phones",
    one: "phone number",
    fields: [
      { name: "label", label: "Name", placeholder: "Mobile", required: true },
      { name: "e164", label: "Number", placeholder: "+447700900123", required: true },
    ],
    note: "In full international form, so a form that wants a country code gets one.",
    build: (read) => {
      const e164 = read("e164").replaceAll(/[\s()-]/gu, "");
      if (!/^\+[1-9]\d{6,14}$/u.test(e164)) {
        return { ok: false, why: "Start with + and the country code — +447700900123." };
      }
      return {
        ok: true,
        item: {
          label: read("label") || "Phone",
          accountHint: e164,
          origins: [],
          value: { kind: "phone", e164 },
        },
      };
    },
  },
];

/** True when this kind must name the site it belongs to. */
export function needsOrigin(form: VaultKindForm): boolean {
  return originBound(form.kind);
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}
