/**
 * The dashboard is a view onto the core, never an enforcement path.
 *
 * It renders what the core already decided: approvals the gate will check,
 * audit entries the chain already committed to, vault rows that never carried a
 * value. Nothing here is permitted to be the thing that decides — a browser is
 * the last place a security boundary should live, and duplicating a check here
 * would create a second answer that drifts from the first.
 */

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The dashboard has no images, and Next's optimiser is the only thing here
  // that would reach libvips (LGPL). Turning it off means the obligation is
  // documentary rather than operational — see THIRD_PARTY_NOTICES.md.
  images: { unoptimized: true },
  // A stray lockfile in a parent directory otherwise makes Next infer the wrong
  // workspace root and trace files from outside the repo.
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  // Workspace packages are TypeScript source, compiled by Next rather than
  // pre-built. One less build step, and the dashboard always sees the same code
  // the tests ran against.
  transpilePackages: ["@nell/views", "@nell/agent", "@nell/aegis", "@nell/audit", "@nell/shared"],
  eslint: { ignoreDuringBuilds: true },

  /**
   * The workspace packages are NodeNext TypeScript, so they import each other
   * with explicit `.js` specifiers — which is correct, and which webpack does
   * not map back to the `.ts` file on disk. Without this the dashboard cannot
   * import its own monorepo.
   *
   * Told to both bundlers on purpose: Next builds with webpack and serves `dev`
   * with Turbopack, and a project that resolves under one but not the other
   * fails in whichever mode nobody happened to run.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"],
  },
};
