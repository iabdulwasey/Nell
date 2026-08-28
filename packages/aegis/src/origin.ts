/**
 * Origin gate.
 *
 * A vault item is pinned to the origins its owner confirmed. At fill time the
 * server compares the browser's ACTUAL current origin (queried from the browser,
 * never asserted by the model) against that allowlist.
 *
 * This closes the look-alike-domain hole: a model persuaded by a phishing page
 * cannot name the origin it wants, so it cannot talk the server into filling a
 * credential on evil.example.
 */

export type OriginDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: OriginDenialReason };

export type OriginDenialReason =
  | "not-allowlisted"
  | "insecure-scheme"
  | "malformed-origin"
  | "empty-allowlist";

/** Normalize to a bare origin, rejecting anything with a path or query. */
export function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export interface OriginCheck {
  /** The origin the browser is actually on, read from the live session. */
  readonly actualOrigin: string;
  /** Origins the user confirmed for this vault item. */
  readonly allowlist: readonly string[];
  /**
   * Permit http:// — only ever for local development targets. Production fills
   * require https so a credential is never typed into a cleartext page.
   */
  readonly allowInsecure?: boolean;
}

export function checkOrigin(check: OriginCheck): OriginDecision {
  if (check.allowlist.length === 0) {
    return { allowed: false, reason: "empty-allowlist" };
  }

  const actual = normalizeOrigin(check.actualOrigin);
  if (!actual) return { allowed: false, reason: "malformed-origin" };

  if (!check.allowInsecure && new URL(actual).protocol !== "https:") {
    return { allowed: false, reason: "insecure-scheme" };
  }

  // Exact match only. No suffix matching: "evil-example.com" must never satisfy
  // an allowlist entry of "example.com".
  const permitted = check.allowlist
    .map(normalizeOrigin)
    .filter((value): value is string => value !== undefined);

  return permitted.includes(actual)
    ? { allowed: true }
    : { allowed: false, reason: "not-allowlisted" };
}

export function explainOriginDenial(reason: OriginDenialReason): string {
  switch (reason) {
    case "not-allowlisted":
      return "This site is not on the approved list for that saved credential.";
    case "insecure-scheme":
      return "Refusing to fill a credential on a page that is not HTTPS.";
    case "malformed-origin":
      return "The browser reported an origin that could not be parsed.";
    case "empty-allowlist":
      return "That saved credential has no approved sites yet.";
  }
}
