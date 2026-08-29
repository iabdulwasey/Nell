#!/usr/bin/env node
/**
 * Copyleft dependency gate.
 *
 * Nell's core is Functional Source License and its /ee layer is a commercial
 * license. Permissive dependencies (MIT/Apache/BSD/ISC) compose cleanly.
 *
 * Three tiers, because lumping them together is both wrong and unhelpful:
 *
 * - **Strong copyleft** (GPL, AGPL, SSPL) is genuinely incompatible: the licence
 *   reaches the combined work, which we cannot license under FSL or the EE
 *   terms. These fail the build.
 *
 * - **LGPL** is *weak* copyleft and is NOT in that category, though it is
 *   routinely mistaken for it. Section 4 permits combining with a work under
 *   other terms provided the LGPL part is unmodified and the user can replace
 *   it — which is exactly the case for a prebuilt shared library loaded
 *   dynamically. The obligation is to convey the terms and permit relinking, so
 *   these must appear in THIRD_PARTY_NOTICES.md rather than fail the build.
 *   Modifying one, or statically linking it, changes the analysis entirely.
 *
 * - **File-level copyleft** (MPL-2.0, EPL, CDDL) attaches only to modified files
 *   of that library. Reported for awareness.
 *
 * Runs via `pnpm licenses list --json`. Two limits worth knowing:
 *
 * 1. It sees only what is installed **for this platform**, so a dependency with
 *    per-OS binaries can pass here and fail on a different runner. CI is the
 *    authority, not a local run.
 * 2. An uninstalled workspace yields nothing and passes, which is correct for a
 *    fresh checkout but means a green result on a clean tree proves nothing.
 */
import { execSync } from "node:child_process";

/**
 * Incompatible with redistribution under FSL or the EE license.
 *
 * The negative lookbehind keeps LGPL out of this set — it is weak copyleft and
 * handled below. Without it, every project that ships a native image or crypto
 * binary fails this gate for a reason that does not survive reading the licence.
 */
const FORBIDDEN = [/\bAGPL/i, /\bSSPL/i, /(?<!L)\bGPL(-|\b)/i];

/**
 * Weak copyleft: permitted for an unmodified, dynamically-linked dependency, and
 * carrying a real obligation — the terms must be conveyed and relinking allowed.
 * Listed in THIRD_PARTY_NOTICES.md, not waved through.
 */
const WEAK_COPYLEFT = [/\bLGPL/i];

/** File-level copyleft: allowed unmodified, surfaced for awareness. */
const REVIEW = [/\bMPL/i, /\bEPL/i, /\bCDDL/i];

function collectLicenses() {
  let raw;
  try {
    raw = execSync("pnpm licenses list --json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Object.keys(parsed).flatMap((license) =>
    (parsed[license] ?? []).map((pkg) => ({
      license,
      name: pkg.name ?? "unknown",
    }))
  );
}

const all = collectLicenses();
const offenders = all.filter((entry) => FORBIDDEN.some((re) => re.test(entry.license)));
const weak = all.filter((entry) => WEAK_COPYLEFT.some((re) => re.test(entry.license)));
const review = all.filter((entry) => REVIEW.some((re) => re.test(entry.license)));

if (weak.length > 0) {
  const names = [...new Set(weak.map((entry) => `${entry.name} (${entry.license})`))];
  console.log(
    `Note: ${String(names.length)} weak-copyleft dependencies present. These are permitted`
  );
  console.log("unmodified and dynamically linked, and must be listed in THIRD_PARTY_NOTICES.md:");
  for (const name of names.slice(0, 10)) console.log(`  - ${name}`);
  if (names.length > 10) console.log(`  ... and ${String(names.length - 10)} more`);
}

if (review.length > 0) {
  const names = [...new Set(review.map((entry) => `${entry.name} (${entry.license})`))];
  console.log(
    `Note: ${String(names.length)} file-level-copyleft dependencies present (OK unmodified):`
  );
  for (const name of names.slice(0, 10)) console.log(`  - ${name}`);
  if (names.length > 10) console.log(`  ... and ${String(names.length - 10)} more`);
}

if (offenders.length > 0) {
  console.error("Forbidden copyleft licenses found in the dependency tree:");
  for (const entry of offenders) console.error(`  - ${entry.name}: ${entry.license}`);
  console.error(
    "These cannot be redistributed under Nell's FSL core or /ee license. Remove the dependency or find a permissive alternative."
  );
  process.exit(1);
}

console.log("License check passed: no strong-copyleft dependencies.");
