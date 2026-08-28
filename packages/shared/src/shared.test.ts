import { describe, expect, it } from "vitest";
import {
  accessScopeForUser,
  assertSameWorkspace,
  combineProvenance,
  mayAuthorizeAction,
  sameWorkspace,
  scopeFromPrincipal,
} from "./index.js";

describe("accessScopeForUser", () => {
  it("is deterministic for the same user", () => {
    expect(accessScopeForUser("user-1").workspaceId).toBe(accessScopeForUser("user-1").workspaceId);
  });

  it("separates different users", () => {
    expect(accessScopeForUser("user-1").workspaceId).not.toBe(
      accessScopeForUser("user-2").workspaceId
    );
  });

  // The workspace id ends up in encryption AAD and log lines, so it must not
  // carry the raw identity-provider id.
  it("does not leak the raw user id", () => {
    const userId = "better-auth:abc-123-secret";
    const scope = accessScopeForUser(userId);
    expect(scope.workspaceId).not.toContain(userId);
    expect(scope.workspaceId).toMatch(/^personal:[0-9a-f]{32}$/u);
  });

  it("trims surrounding whitespace", () => {
    expect(accessScopeForUser("  user-1  ").workspaceId).toBe(
      accessScopeForUser("user-1").workspaceId
    );
  });

  it("refuses an empty user id", () => {
    expect(() => accessScopeForUser("   ")).toThrow(/authenticated user/iu);
  });
});

describe("scopeFromPrincipal", () => {
  it("derives the personal workspace when none is supplied", () => {
    expect(scopeFromPrincipal({ id: "user-1" })).toEqual(accessScopeForUser("user-1"));
  });

  it("honors an explicitly resolved workspace", () => {
    expect(scopeFromPrincipal({ id: "user-1", workspaceId: "team:xyz" }).workspaceId).toBe(
      "team:xyz"
    );
  });

  it("fails closed on a malformed principal", () => {
    expect(() => scopeFromPrincipal({})).toThrow();
    expect(() => scopeFromPrincipal(null)).toThrow();
  });
});

describe("workspace guards", () => {
  const scope = accessScopeForUser("user-1");
  const other = accessScopeForUser("user-2");

  it("compares workspaces", () => {
    expect(sameWorkspace(scope, scope)).toBe(true);
    expect(sameWorkspace(scope, other)).toBe(false);
  });

  it("throws opaquely on cross-tenant access", () => {
    expect(() => {
      assertSameWorkspace(scope, other.workspaceId);
    }).toThrow("Not found.");
    expect(() => {
      assertSameWorkspace(scope, scope.workspaceId);
    }).not.toThrow();
  });
});

describe("provenance", () => {
  it("never increases trust when combining", () => {
    expect(combineProvenance(["user", "untrusted"])).toBe("untrusted");
    expect(combineProvenance(["system", "untrusted"])).toBe("untrusted");
    expect(combineProvenance(["user", "system"])).toBe("user");
    expect(combineProvenance(["system"])).toBe("system");
    expect(combineProvenance([])).toBe("system");
  });

  it("only lets trusted provenance authorize actions", () => {
    expect(mayAuthorizeAction("user")).toBe(true);
    expect(mayAuthorizeAction("system")).toBe(true);
    expect(mayAuthorizeAction("untrusted")).toBe(false);
  });
});
