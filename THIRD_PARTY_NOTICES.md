# Third-Party Notices

Nell includes and depends on third-party software. Each component is licensed
under its own terms. This file will enumerate them as dependencies are added.

Permissive dependencies (MIT, Apache-2.0, BSD, ISC) are compatible with Nell's
Functional Source License core and its Enterprise Edition license, provided
their copyright and license notices are preserved.

Strong-copyleft licenses (GPL, AGPL, SSPL) are **not** compatible and fail the
build via `scripts/check-licenses.mjs`.

LGPL is _weak_ copyleft and is often wrongly grouped with the above. Section 4 of
LGPL-3.0 permits combining with a work under other terms where the LGPL portion
is **unmodified** and **dynamically linked**, and the recipient can replace it.
Nell relies on that permission, so LGPL dependencies are listed below rather than
rejected. If one is ever modified or statically linked, that permission no longer
applies and the dependency must be removed.

File-level copyleft (MPL-2.0, EPL, CDDL) is permitted for **unmodified**
dependencies — the obligation attaches only to modified files of that library.
The license check reports these for awareness. If you ever patch such a
dependency in place, those file changes must be published under its license.

## Notices

- Browser automation tool contracts follow the conventions of Kernel's
  open-source MCP server (MIT).

### LGPL-3.0-or-later (unmodified, dynamically linked)

- **`@img/sharp-libvips-*`** — prebuilt [libvips](https://github.com/libvips/libvips)
  binaries, reached through `sharp` (Apache-2.0), which Next.js lists as an
  optional dependency for image optimisation.

  Nell does not modify these binaries, does not link them statically, and does
  not use Next.js image optimisation — the dashboard sets
  `images.unoptimized`, so nothing in Nell calls libvips at runtime. The
  binaries are redistributable and replaceable: deleting the package from
  `node_modules` and installing another build of the same version leaves Nell
  working identically. Source for libvips is available at the link above under
  LGPL-3.0-or-later.

_(Generated notices for the full dependency tree will be added here once
dependencies are installed.)_
