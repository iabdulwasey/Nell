# Third-Party Notices

Nell includes and depends on third-party software. Each component is licensed
under its own terms. This file will enumerate them as dependencies are added.

Permissive dependencies (MIT, Apache-2.0, BSD, ISC) are compatible with Nell's
Functional Source License core and its Enterprise Edition license, provided
their copyright and license notices are preserved.

Strong-copyleft licenses (GPL, LGPL, AGPL, SSPL) are **not** compatible and fail
the build via `scripts/check-licenses.mjs`.

File-level copyleft (MPL-2.0, EPL, CDDL) is permitted for **unmodified**
dependencies — the obligation attaches only to modified files of that library.
The license check reports these for awareness. If you ever patch such a
dependency in place, those file changes must be published under its license.

## Notices

- Browser automation tool contracts follow the conventions of Kernel's
  open-source MCP server (MIT).

_(Generated notices for the full dependency tree will be added here once
dependencies are installed.)_
