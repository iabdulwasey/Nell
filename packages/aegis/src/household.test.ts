import { describe, expect, it } from "vitest";
import {
  canAccess,
  explainAccessRefusal,
  removeMember,
  share,
  supervisionNotice,
  unshare,
  visibleTo,
  DEFAULT_VISIBILITY,
  type Membership,
  type OwnedThing,
} from "./index.js";

const NOW = 1_700_000_000_000;
const HOUSE = "house-1";

const members: Membership[] = [
  { householdId: HOUSE, userId: "ada", role: "owner", joinedAt: NOW },
  { householdId: HOUSE, userId: "sam", role: "member", joinedAt: NOW },
  { householdId: HOUSE, userId: "kid", role: "supervised", joinedAt: NOW },
];

function thing(overrides: Partial<OwnedThing> = {}): OwnedThing {
  return { id: "t1", ownerUserId: "ada", householdId: HOUSE, visibility: "private", ...overrides };
}

describe("private by default", () => {
  /**
   * A shared-by-default household would be convenient for the ten percent of
   * things people want to share and a disaster for the ninety percent they do
   * not — and nobody discovers which is which until afterwards.
   */
  it("defaults to private", () => {
    expect(DEFAULT_VISIBILITY).toBe("private");
  });

  it("keeps one member's private things from another", () => {
    expect(
      canAccess({ thing: thing({ ownerUserId: "sam" }), viewerUserId: "ada", memberships: members })
    ).toEqual({ ok: false, reason: "private-to-someone-else" });
  });

  /**
   * "Everyone in the household can see everything" is a sentence that ends
   * relationships, and an assistant should not be the thing that discovers a
   * surprise party.
   */
  it("does not let the household owner read a member's private things", () => {
    const samsThing = thing({ ownerUserId: "sam" });
    expect(canAccess({ thing: samsThing, viewerUserId: "ada", memberships: members }).ok).toBe(
      false
    );
  });

  it("lets anyone in the household see what was shared", () => {
    const shared = thing({ ownerUserId: "sam", visibility: "household" });
    expect(canAccess({ thing: shared, viewerUserId: "ada", memberships: members }).ok).toBe(true);
  });

  it("lets someone see their own things, always", () => {
    expect(canAccess({ thing: thing(), viewerUserId: "ada", memberships: members }).ok).toBe(true);
  });

  it("refuses someone from another household entirely", () => {
    const shared = thing({ visibility: "household" });
    expect(canAccess({ thing: shared, viewerUserId: "stranger", memberships: members })).toEqual({
      ok: false,
      reason: "not-a-member",
    });
  });
});

describe("leaving a household", () => {
  const left: Membership[] = [
    ...members.filter((m) => m.userId !== "sam"),
    { householdId: HOUSE, userId: "sam", role: "member", joinedAt: NOW, removedAt: NOW + 1000 },
  ];

  /**
   * Losing access to your own bookings because a relationship ended would be a
   * cruel way for software to behave.
   */
  it("leaves someone their own things", () => {
    const samsThing = thing({ ownerUserId: "sam" });
    expect(canAccess({ thing: samsThing, viewerUserId: "sam", memberships: left }).ok).toBe(true);
  });

  it("stops them seeing what the household shares", () => {
    const shared = thing({ visibility: "household" });
    expect(canAccess({ thing: shared, viewerUserId: "sam", memberships: left })).toEqual({
      ok: false,
      reason: "removed-from-household",
    });
  });

  it("removes idempotently", () => {
    const membership = members[1]!;
    const once = removeMember(membership, NOW + 1000);
    expect(removeMember(once, NOW + 9999).removedAt).toBe(NOW + 1000);
  });
});

describe("supervision is narrow and never quiet", () => {
  it("lets an owner see a supervised member's tasks", () => {
    const kidsThing = thing({ ownerUserId: "kid" });
    expect(canAccess({ thing: kidsThing, viewerUserId: "ada", memberships: members }).ok).toBe(
      true
    );
  });

  it("does not work the other way round", () => {
    expect(canAccess({ thing: thing(), viewerUserId: "kid", memberships: members }).ok).toBe(false);
  });

  it("does not extend to an ordinary member", () => {
    const samsThing = thing({ ownerUserId: "sam" });
    expect(canAccess({ thing: samsThing, viewerUserId: "ada", memberships: members }).ok).toBe(
      false
    );
  });

  /**
   * Monitoring someone who does not know they are monitored is a different
   * product with a different name.
   */
  it("tells the supervised person exactly what is visible", () => {
    const notice = supervisionNotice("Ada");
    expect(notice).toContain("Ada can see the tasks");
    expect(notice).toContain("cannot see your saved passwords or cards");
    expect(notice).toContain("tell you if this changes");
  });
});

describe("filtering happens in the query, not the interface", () => {
  /**
   * A list filtered in the interface is a list that was fetched, and anything
   * fetched can be logged, cached, or sent to a model.
   */
  it("never returns another member's private things", () => {
    const all = [
      thing({ id: "mine", ownerUserId: "ada" }),
      thing({ id: "theirs", ownerUserId: "sam" }),
      thing({ id: "shared", ownerUserId: "sam", visibility: "household" }),
    ];

    const visible = visibleTo(all, "ada", members);
    expect(visible.map((t) => t.id).sort()).toEqual(["mine", "shared"]);
  });
});

describe("sharing", () => {
  it("shares something into the household", () => {
    const decision = share(thing(), "ada", HOUSE, members);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.thing.visibility).toBe("household");
  });

  /**
   * Otherwise "private" would mean "private unless someone with a title decides
   * otherwise", which is not what the word does for the person relying on it.
   */
  it("does not let anyone else share your things, including the owner", () => {
    const samsThing = thing({ ownerUserId: "sam" });
    const decision = share(samsThing, "ada", HOUSE, members);

    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-the-owner");
  });

  it("refuses to share into a household you are not in", () => {
    const decision = share(thing(), "ada", "other-house", members);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-a-member");
  });

  it("takes something back, always", () => {
    const shared = thing({ visibility: "household" });
    const decision = unshare(shared, "ada");
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.thing.visibility).toBe("private");
  });

  it("does not let someone else unshare your thing", () => {
    expect(unshare(thing(), "sam").ok).toBe(false);
  });

  it("explains every refusal", () => {
    for (const reason of [
      "not-a-member",
      "private-to-someone-else",
      "removed-from-household",
      "different-household",
    ] as const) {
      expect(explainAccessRefusal(reason).length).toBeGreaterThan(10);
    }
  });
});
