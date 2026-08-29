/**
 * Deliberately empty, and deliberately present.
 *
 * PostCSS resolves its config by walking up the directory tree. Without a file
 * here it walks straight out of this repository and finds whatever happens to
 * sit in a parent directory — which on this machine is an unrelated project's
 * Tailwind config, whose plugin is not installed here. The build then fails with
 * "Cannot find module @tailwindcss/postcss" and no obvious connection to
 * anything in the repo.
 *
 * The dashboard uses plain CSS. This file exists so the search stops here.
 */
export default { plugins: {} };
