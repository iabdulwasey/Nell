/**
 * @nell/license
 *
 * Public license-key verification. Ships the Ed25519 PUBLIC key and
 * `isLicensed(feature)`, which verifies a signed license key locally and FAILS
 * SOFT: with no key, an invalid key, or an expired key, every feature reports
 * false and the source-available core keeps running. The private signing key is
 * NOT in this repo.
 *
 * Governed by: docs/adr/0002-licensing-open-core.md
 *
 * Status: scaffold. The signature-verification implementation lands with the
 * hosted tier; the fail-soft contract below is stable so /ee packages can gate
 * on it from day one.
 */

/** Commercial features gated by a valid license key. */
export type LicensedFeature =
  | "billing"
  | "stripe-issuing"
  | "control-plane"
  | "admin"
  | "onboarding-gating";

/**
 * Whether the given commercial feature is unlocked by a valid, signed license
 * key. FAILS SOFT: returns false whenever a valid key is absent, so the core
 * never breaks on a missing key.
 *
 * Scaffold behavior: always false (no key verification wired yet).
 */
export function isLicensed(_feature: LicensedFeature): boolean {
  // TODO(phase-hosted): verify NELL_LICENSE_KEY's Ed25519 signature against the
  // embedded public key, check expiry/entitlements, cache ~24h, fail soft.
  return false;
}
