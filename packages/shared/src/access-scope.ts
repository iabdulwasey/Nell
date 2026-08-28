/**
 * Tenancy primitive.
 *
 * Every server entrypoint resolves an AccessScope, and every storage query is
 * filtered by its workspaceId. The workspace id is derived deterministically
 * from the user id by hashing, so it never leaks the raw identity provider id
 * into workspace-scoped artifacts (session names, encryption AAD, log lines).
 */

import { createHash } from "node:crypto";
import { z } from "zod";

/** Resolved caller identity plus the workspace every query is scoped to. */
export interface AccessScope {
  readonly userId: string;
  readonly workspaceId: string;
}

/** Namespace prefix for a single-user personal workspace. */
const PERSONAL_PREFIX = "personal:";

/**
 * Derive the stable personal workspace for a user id.
 *
 * Deterministic (same user always maps to the same workspace) and one-way (the
 * workspace id does not reveal the user id).
 */
export function accessScopeForUser(userId: string): AccessScope {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("An authenticated user is required.");
  }

  const digest = createHash("sha256").update(normalizedUserId).digest("hex").slice(0, 32);

  return {
    userId: normalizedUserId,
    workspaceId: `${PERSONAL_PREFIX}${digest}`,
  };
}

/**
 * Shape of an authenticated principal as it arrives from the auth layer or a
 * channel adapter. Parsed rather than trusted so a malformed principal fails
 * closed instead of silently producing a wrong scope.
 */
export const principalSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
});

export type Principal = z.infer<typeof principalSchema>;

/**
 * Build an AccessScope from a principal. When the principal carries an explicit
 * workspaceId (a channel adapter that already resolved it) that value is used;
 * otherwise the personal workspace is derived.
 */
export function scopeFromPrincipal(input: unknown): AccessScope {
  const principal = principalSchema.parse(input);
  const derived = accessScopeForUser(principal.id);
  if (!principal.workspaceId) return derived;
  return { userId: derived.userId, workspaceId: principal.workspaceId };
}

/** True when two scopes address the same workspace. */
export function sameWorkspace(a: AccessScope, b: AccessScope): boolean {
  return a.workspaceId === b.workspaceId;
}

/**
 * Guard for cross-tenant access. Throws rather than returning false so a missed
 * check cannot silently fall through to a permissive branch.
 */
export function assertSameWorkspace(scope: AccessScope, resourceWorkspaceId: string): void {
  if (scope.workspaceId !== resourceWorkspaceId) {
    // Deliberately opaque: do not reveal whether the resource exists.
    throw new Error("Not found.");
  }
}
