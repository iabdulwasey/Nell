/**
 * Build a deployable artefact.
 *
 * Until now `apps/core` ran through `tsx` straight from TypeScript source,
 * which is fine on a laptop and is not a deployment: it means the production
 * container compiles on every boot, ships the whole toolchain, and has no single
 * file you can point `node` at. The README invites people to self-host, so the
 * thing they run should be a build output rather than a dev loop.
 *
 * **Workspace code is bundled; third-party code is not.** The `@nell/*`
 * packages export TypeScript source — deliberately, so a change is visible
 * without a build step across a dozen packages — and bundling is what turns
 * that into something `node` can execute. Dependencies stay external because
 * several of them refuse to be bundled and would fail in ways that look like
 * our bug: `pg` loads a native driver when one is present, and
 * `playwright-core` resolves browsers and driver scripts by walking its own
 * package directory, which is not where it lands inside a bundle.
 *
 * ESM output, because the source is ESM and downgrading it would change how
 * `import.meta` and top-level await behave — both of which `main.ts` uses.
 */

import { build } from "esbuild";

/**
 * Everything that is not ours stays external — decided by a rule, not a list.
 *
 * The first version listed this package's own dependencies, which missed every
 * *transitive* one: `@dbos-inc/dbos-sdk` comes in through `@nell/durable`, got
 * bundled, and failed on its optional `require("winston")` — a dependency it
 * probes for at runtime and does not need. A list would also have gone stale
 * the same way the RLS table list did.
 *
 * The rule is the thing that is actually true: bundle our own packages, because
 * they export TypeScript source and `node` cannot run them; leave everything
 * else where npm put it.
 */
const externaliseThirdParty = {
  name: "externalise-third-party",
  setup(pluginBuild) {
    // Built by constructor rather than as a literal: esbuild compiles this with
    // Go's regexp engine, which rejects the `u` flag our lint rule requires on
    // every literal. A bare specifier is anything not starting with `.` or `/`.
    pluginBuild.onResolve({ filter: new RegExp("^[^./]") }, (args) =>
      args.path.startsWith("@nell/") ? undefined : { path: args.path, external: true }
    );
  },
};

const result = await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  plugins: [externaliseThirdParty],
  sourcemap: true,
  // Keeps stack traces pointing at real function names, which matters more here
  // than the few kilobytes minifying would save on a server-side bundle.
  minify: false,
  logLevel: "info",
  /**
   * `require` does not exist in an ESM bundle, and several dependencies reach
   * for it. This gives them one built from the output file's own URL.
   */
  banner: {
    js: [
      "import { createRequire as __nellCreateRequire } from 'node:module';",
      "const require = __nellCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});

if (result.errors.length > 0) process.exit(1);
console.log("built dist/main.js");
