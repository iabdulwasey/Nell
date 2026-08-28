/**
 * @nell-ee/control-plane
 *
 * The multi-tenant control plane / tenant administration for running Nell as a hosted service.
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
//   if (!isLicensed("control-plane")) return unavailable();

export const __stub = true;
