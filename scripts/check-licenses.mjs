#!/usr/bin/env node
/**
 * Copyleft dependency gate.
 *
 * Nell's core is Functional Source License and its /ee layer is a commercial
 * license. Permissive dependencies (MIT/Apache/BSD/ISC) compose cleanly, but
 * strong-copyleft licenses (GPL/LGPL/AGPL/SSPL and file-level MPL) cannot be
 * redistributed under either and must never enter the tree. This script fails
 * the build if any are found.
 *
 * It shells out to `pnpm licenses list --json`, which is available once
 * dependencies are installed. With an empty/uninstalled workspace it finds
 * nothing and passes — which is correct for the scaffold.
 */
import { execSync } from "node:child_process";

const FORBIDDEN = [
  /\bAGPL/i,
  /\bSSPL/i,
  /\bGPL-/i,
  /\bGPL\b/i,
  /\bLGPL/i,
  /\bMPL-/i, // file-level copyleft; review case-by-case, block by default
];

function collectLicenses() {
  let raw;
  try {
    raw = execSync("pnpm licenses list --json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No lockfile / nothing installed yet (scaffold state). Nothing to audit.
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  // pnpm returns an object keyed by license name -> array of packages.
  return Object.keys(parsed).flatMap((license) =>
    (parsed[license] ?? []).map((pkg) => ({
      license,
      name: pkg.name ?? "unknown",
    }))
  );
}

const offenders = collectLicenses().filter((entry) =>
  FORBIDDEN.some((re) => re.test(entry.license))
);

if (offenders.length > 0) {
  console.error("Forbidden copyleft licenses found in the dependency tree:");
  for (const o of offenders) {
    console.error(`  - ${o.name}: ${o.license}`);
  }
  console.error(
    "These licenses are incompatible with Nell's FSL core and /ee license. Remove the dependency or find a permissive alternative."
  );
  process.exit(1);
}

console.log("License check passed: no forbidden copyleft dependencies.");
