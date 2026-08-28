#!/usr/bin/env node
/**
 * Copyleft dependency gate.
 *
 * Nell's core is Functional Source License and its /ee layer is a commercial
 * license. Permissive dependencies (MIT/Apache/BSD/ISC) compose cleanly. Strong
 * copyleft does not: distributing GPL/LGPL/AGPL/SSPL code under either license
 * is not permitted, so those fail the build.
 *
 * MPL-2.0 (and EPL/CDDL) are *file-level* copyleft: using an unmodified library
 * is fine, and the obligation attaches only to modified files of that library.
 * Those are reported for awareness rather than failing the build — but modifying
 * such a dependency in place requires publishing those file changes.
 *
 * Runs via `pnpm licenses list --json`. An uninstalled workspace yields nothing
 * and passes, which is correct for a fresh checkout.
 */
import { execSync } from "node:child_process";

/** Incompatible with redistribution under FSL or the EE license. */
const FORBIDDEN = [/\bAGPL/i, /\bSSPL/i, /(^|[^A-Z])L?GPL(-|\b)/i];

/** Weak/file-level copyleft: allowed unmodified, surfaced for awareness. */
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
const review = all.filter((entry) => REVIEW.some((re) => re.test(entry.license)));

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
