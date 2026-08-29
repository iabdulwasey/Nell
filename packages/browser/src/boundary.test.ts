/**
 * The package root must not reach the driver.
 *
 * Enforced as a test rather than left to reviewers noticing, because the failure
 * is invisible: re-exporting an adapter from the root compiles fine, passes
 * every other test, and only shows up as a dashboard bundle that has quietly
 * absorbed a browser binary — or as a build that fails in a package which has no
 * business touching Playwright at all.
 *
 * This is a real thing that happened. The view layer imports the policy engine
 * for one hash function; the policy engine imported the browser package for two
 * pure classifiers; the browser package re-exported its Playwright adapters from
 * the root. Three reasonable-looking edges, and the dashboard could not build.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = new URL(".", import.meta.url).pathname;

function sourceOf(...parts: string[]): string {
  return readFileSync(join(here, ...parts), "utf8");
}

describe("the browser package root stays free of the driver", () => {
  it("does not export the adapters", () => {
    const index = sourceOf("index.ts");
    expect(index).not.toMatch(/export\s*\{[^}]*LocalBrowserProvider/u);
    expect(index).not.toMatch(/export\s*\{[^}]*LocalMachineHost/u);
    expect(index).not.toMatch(/export\s*\{[^}]*runComputerActions/u);
  });

  it("pulls in nothing from the adapters tree except types", () => {
    const index = sourceOf("index.ts");
    for (const line of index.split("\n")) {
      if (!line.includes("./adapters/")) continue;
      // A type-only re-export erases at build time and carries no dependency.
      expect(line).toMatch(/export\s+type/u);
    }
  });

  it("has no module in the root graph importing playwright at runtime", () => {
    for (const file of [
      "index.ts",
      "provider.ts",
      "dsl.ts",
      "computer.ts",
      "machine.ts",
      "perception.ts",
    ]) {
      const source = sourceOf(file);
      const runtimeImport = /^import\s+(?!type\b)[^;]*from\s+["']playwright/mu;
      expect(source, `${file} imports playwright at runtime`).not.toMatch(runtimeImport);
    }
  });

  // The adapters are still reachable — deliberately, from their own entry point.
  it("still offers the adapters under their own path", () => {
    const adapters = sourceOf("adapters", "index.ts");
    expect(adapters).toContain("LocalBrowserProvider");
    expect(adapters).toContain("LocalMachineHost");
  });
});
