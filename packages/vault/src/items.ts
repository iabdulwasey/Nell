/**
 * Structured vault item schemas.
 *
 * Items are typed, not opaque strings. This is what makes multi-field checkout
 * and intake-paperwork autofill possible (a single unstructured "address" blob
 * cannot fill line1/city/region/postal separately), and it lets the autofill
 * layer resolve exactly the requested fields and nothing more.
 *
 * Deliberate omission: card security codes (CVC/CVV) are NEVER stored. PCI DSS
 * forbids retaining them post-authorization, and no feature here needs it — when
 * a merchant demands one the user supplies it just-in-time.
 */

import { z } from "zod";

export const vaultItemKindSchema = z.enum(["login", "payment", "address", "identity", "phone"]);

/**
 * Whether an item may only be used on sites it was stored for.
 *
 * A password is bound to one site because a password *means* nothing anywhere
 * else — and because a stored password with no site attached is the phishing
 * hole: a page that looks close enough gets it. That binding is the one real
 * improvement over how the vaults this was modelled on work, and it is not
 * optional for a login.
 *
 * An address is not bound, and scoping it would be security theatre. It is
 * printed on every parcel the person has ever received and read aloud to every
 * delivery driver; restricting it to one shop would make the "fill in the
 * intake paperwork" case impossible without making anything safer. Same for a
 * phone number.
 *
 * A card is the interesting one and is deliberately unbound too: people shop in
 * places they have not shopped before, and an allowlist would refuse exactly
 * then. What protects it instead is stronger than a list — the CVC is never
 * stored, so a number lifted from a page is largely unusable, and anything that
 * commits money meets the spend gate regardless.
 *
 * What is enforced for every kind alike: https only, the session tainted the
 * moment a value lands, and every capture afterwards masked.
 *
 * Derived from the kind rather than stored on the row on purpose. A column
 * could disagree with the kind; a function cannot.
 */
export function originBound(kind: VaultItemKind): boolean {
  return kind === "login";
}

export type VaultItemKind = z.infer<typeof vaultItemKindSchema>;

/** An exact https(s) origin: scheme + host + optional port, no path or query. */
const originSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && value === url.origin;
  } catch {
    return false;
  }
}, "Must be an exact origin, for example https://example.com");

export const loginSecretSchema = z.object({
  kind: z.literal("login"),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  /** Base32 TOTP seed, so 2FA can be satisfied without touching the inbox. */
  totpSecret: z.string().min(8).max(512).optional(),
  /**
   * Origins this credential may be filled into. The server checks the browser's
   * ACTUAL origin against this list; the model never gets to name the target.
   */
  origins: z.array(originSchema).min(1).max(20),
});

export const paymentCardSchema = z.object({
  kind: z.literal("payment"),
  cardholderName: z.string().min(1).max(120),
  /** PAN, digits only. */
  number: z.string().regex(/^\d{12,19}$/u, "Card number must be 12-19 digits."),
  expiryMonth: z.number().int().min(1).max(12),
  expiryYear: z.number().int().min(2024).max(2100),
  billingPostalCode: z.string().min(1).max(16),
  // No securityCode field, by design. See the file header.
});

export const addressSchema = z.object({
  kind: z.literal("address"),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(32),
  /** ISO 3166-1 alpha-2. */
  country: z.string().length(2).toUpperCase(),
});

export const identitySchema = z.object({
  kind: z.literal("identity"),
  legalName: z.string().min(1).max(200),
  dateOfBirth: z.iso.date().optional(),
  email: z.email().optional(),
  /** Reference to a government id held elsewhere; never the number itself. */
  governmentIdRef: z.string().max(120).optional(),
});

export const phoneSchema = z.object({
  kind: z.literal("phone"),
  /** E.164, e.g. +14155550123. */
  e164: z.string().regex(/^\+[1-9]\d{6,14}$/u, "Must be an E.164 phone number."),
});

export const vaultItemValueSchema = z.discriminatedUnion("kind", [
  loginSecretSchema,
  paymentCardSchema,
  addressSchema,
  identitySchema,
  phoneSchema,
]);

export type VaultItemValue = z.infer<typeof vaultItemValueSchema>;

/** Serialize for encryption. Versioned so the shape can evolve. */
export function serializeVaultItem(value: VaultItemValue): string {
  return JSON.stringify({ version: 1, ...vaultItemValueSchema.parse(value) });
}

/** Parse a decrypted item, validating it still matches a known shape. */
export function parseVaultItem(serialized: string): VaultItemValue {
  const parsed: unknown = JSON.parse(serialized);
  return vaultItemValueSchema.parse(parsed);
}

/**
 * Card brand from the PAN prefix. This is the ONLY card detail the model is ever
 * shown ("Visa ending 4242") — never the number itself.
 */
export function paymentCardBrand(number: string): string {
  const digits = number.replaceAll(/\D/gu, "");
  if (/^4/u.test(digits)) return "Visa";
  if (/^(5[1-5]|2[2-7])/u.test(digits)) return "Mastercard";
  if (/^3[47]/u.test(digits)) return "American Express";
  if (/^6(?:011|5)/u.test(digits)) return "Discover";
  return "Card";
}

/** Luhn check so a typo is caught at entry rather than at checkout. */
export function isLuhnValid(number: string): boolean {
  const digits = number.replaceAll(/\D/gu, "");
  if (digits.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
