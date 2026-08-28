/**
 * @nell/shared
 *
 * Cross-cutting zod schemas, the AccessScope tenancy primitive, and shared
 * types. Imported by nearly everything; depends on nothing internal.
 *
 * Governed by: docs/architecture.md
 */

export {
  accessScopeForUser,
  assertSameWorkspace,
  principalSchema,
  sameWorkspace,
  scopeFromPrincipal,
  type AccessScope,
  type Principal,
} from "./access-scope.js";

export {
  combineProvenance,
  mayAuthorizeAction,
  provenanceSchema,
  system,
  trusted,
  untrusted,
  type Provenance,
  type Provenanced,
} from "./provenance.js";
