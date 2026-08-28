/**
 * International phone handling.
 *
 * Phone numbers are identity here: an inbound message is matched to an account
 * by its sender number, so normalization has to be correct for every user, not
 * just North American ones.
 *
 * The rule is deliberately strict rather than clever. A bare national number
 * like `07911 123456` is ambiguous without knowing the country — silently
 * assuming +1 would map a UK user onto a wrong, possibly real, US number. So a
 * default region must be supplied explicitly, and without one only E.164 input
 * is accepted.
 *
 * SCOPE, stated plainly: this performs *format-level* normalization. It does not
 * validate against each country's numbering plan, so a well-formed string that
 * is not an assignable number in its country (a US number beginning with 0, say)
 * will pass. Catching those requires numbering-plan data — bring in
 * libphonenumber-js at the point where we start sending real messages. Identity
 * matching is unaffected: normalization is deterministic and idempotent, so the
 * same input always resolves to the same account.
 */

/** E.164: a leading +, a non-zero country code, up to 15 digits total. */
const E164 = /^\+[1-9]\d{6,14}$/u;

/** Calling codes for the regions we can disambiguate a national number for. */
const CALLING_CODES: Readonly<Record<string, string>> = {
  US: "1",
  CA: "1",
  GB: "44",
  IN: "91",
  AU: "61",
  DE: "49",
  FR: "33",
  ES: "34",
  IT: "39",
  NL: "31",
  BR: "55",
  MX: "52",
  JP: "81",
  SG: "65",
  AE: "971",
  ZA: "27",
  NG: "234",
  PK: "92",
  BD: "880",
  ID: "62",
};

/** Regions whose national format uses a trunk prefix that E.164 drops. */
const TRUNK_PREFIX_REGIONS = new Set([
  "GB",
  "AU",
  "DE",
  "FR",
  "ES",
  "IT",
  "NL",
  "IN",
  "ZA",
  "NG",
  "PK",
  "BD",
  "ID",
  "BR",
]);

export type Region = keyof typeof CALLING_CODES | (string & {});

/** Whether a string is already valid E.164. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

/**
 * Normalize a phone number to E.164.
 *
 * Returns undefined rather than guessing when the input is ambiguous — a wrong
 * normalization silently routes someone's messages to another account.
 */
export function normalizePhoneNumber(input: string, defaultRegion?: Region): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  // Already international: strip formatting and validate.
  if (trimmed.startsWith("+")) {
    const candidate = `+${trimmed.slice(1).replaceAll(/\D/gu, "")}`;
    return isE164(candidate) ? candidate : undefined;
  }

  // "00" is the international prefix in much of the world.
  const digitsOnly = trimmed.replaceAll(/\D/gu, "");
  if (digitsOnly.startsWith("00")) {
    const candidate = `+${digitsOnly.slice(2)}`;
    return isE164(candidate) ? candidate : undefined;
  }

  // National format needs a region to be meaningful.
  if (!defaultRegion) return undefined;
  const callingCode = CALLING_CODES[defaultRegion.toUpperCase()];
  if (!callingCode) return undefined;

  // Drop a trunk prefix ("0") where the region uses one.
  const national =
    TRUNK_PREFIX_REGIONS.has(defaultRegion.toUpperCase()) && digitsOnly.startsWith("0")
      ? digitsOnly.slice(1)
      : digitsOnly;

  const candidate = `+${callingCode}${national}`;
  return isE164(candidate) ? candidate : undefined;
}

/** Last four digits, for display. Never render a full stored number. */
export function maskPhoneNumber(e164: string): string {
  const digits = e164.replaceAll(/\D/gu, "");
  return digits.length < 4 ? "••••" : `••• ••• ${digits.slice(-4)}`;
}

/** Regions this build can normalize national numbers for. */
export function supportedRegions(): string[] {
  return Object.keys(CALLING_CODES).sort();
}
