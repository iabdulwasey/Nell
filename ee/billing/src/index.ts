/**
 * @nell-ee/billing
 *
 * Stripe billing and usage metering for the hosted tier.
 *
 * Governed by: docs/adr/0002-licensing-open-core.md
 *
 * COMMERCIAL: licensed under ee/LICENSE (Nell Enterprise Edition).
 * Production use requires a valid signed license key; this module fails soft
 * (feature disabled) when no valid key is present.
 *
 * Status: scaffold stub. Implementation lands per the roadmap.
 */

// TODO(phase-hosted): implement. All entrypoints must gate on the license check:
//   import { isLicensed } from "@nell/license";
//   if (!isLicensed("billing")) return unavailable();

export const __stub = true;
