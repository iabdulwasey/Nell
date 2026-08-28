/**
 * @nell-ee/stripe-issuing
 *
 * Single-use, per-task virtual-card issuing so the spend cap is enforced by the card network itself.
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
//   if (!isLicensed("stripe-issuing")) return unavailable();

export const __stub = true;
