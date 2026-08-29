/**
 * Households: more than one person, one assistant.
 *
 * Partners share a calendar and a car; parents book for children; flatmates
 * split a broadband bill. Refusing to model this does not make it go away — it
 * makes people share one login, which is worse than anything a considered design
 * would produce.
 *
 * The whole difficulty is that a household is not an organisation. There is no
 * administrator, no IT policy, and no expectation that anyone reads a permission
 * matrix. Two things follow, and they pull against each other:
 *
 * **Sharing has to be nearly free**, or nobody uses it and they share a password
 * instead. Adding someone to a household takes an invitation and a tap.
 *
 * **Private things must stay private by default**, because the failure here is
 * not abstract. A vault holds a card and a medical login; a task ledger holds
 * what someone booked. "Everyone in the household can see everything" is a
 * sentence that ends relationships, and an assistant should not be the thing
 * that discovers a surprise party or a job interview.
 *
 * So membership is shared and data is not. A member sees the household's shared
 * things and their own; another member's private tasks and vault items are not
 * merely hidden from the interface, they are outside what a query for that
 * member can return.
 */

import { z } from "zod";

export const householdRoleSchema = z.enum([
  /** Created the household. Can invite and remove; cannot read anyone's private data. */
  "owner",
  /** A full member: own private space, plus the shared one. */
  "member",
  /**
   * Someone whose tasks are visible to an owner — a child, or an elderly parent
   * who asked for help. Deliberately explicit and deliberately visible to them.
   */
  "supervised",
]);

export type HouseholdRole = z.infer<typeof householdRoleSchema>;

export interface Membership {
  readonly householdId: string;
  readonly userId: string;
  readonly role: HouseholdRole;
  readonly joinedAt: number;
  readonly removedAt?: number;
}

/** What a thing belongs to. Chosen when it is created, changeable by its owner. */
export const visibilitySchema = z.enum(["private", "household"]);
export type Visibility = z.infer<typeof visibilitySchema>;

export interface OwnedThing {
  readonly id: string;
  readonly ownerUserId: string;
  readonly householdId?: string;
  readonly visibility: Visibility;
}

/**
 * Everything is private unless someone said otherwise.
 *
 * The default is the whole design. A shared-by-default household would be
 * convenient for the ten percent of things people want to share and a disaster
 * for the ninety percent they do not, and nobody discovers which is which until
 * afterwards.
 */
export const DEFAULT_VISIBILITY: Visibility = "private";

export type AccessRefusal =
  | "not-a-member"
  | "private-to-someone-else"
  | "removed-from-household"
  | "different-household";

export type AccessDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AccessRefusal };

export interface AccessQuestion {
  readonly thing: OwnedThing;
  readonly viewerUserId: string;
  readonly memberships: readonly Membership[];
}

/**
 * Whether someone may see a thing.
 *
 * Note the order: ownership is checked before membership, so a person can always
 * reach their own things even after leaving a household. Losing access to your
 * own bookings because a relationship ended would be a cruel way for a piece of
 * software to behave.
 */
export function canAccess(question: AccessQuestion): AccessDecision {
  const { thing, viewerUserId } = question;

  if (thing.ownerUserId === viewerUserId) return { ok: true };

  if (!thing.householdId) {
    return { ok: false, reason: "private-to-someone-else" };
  }

  const viewer = activeMembership(question.memberships, thing.householdId, viewerUserId);
  if (!viewer) {
    const everRemoved = question.memberships.some(
      (membership) =>
        membership.householdId === thing.householdId &&
        membership.userId === viewerUserId &&
        membership.removedAt !== undefined
    );
    return { ok: false, reason: everRemoved ? "removed-from-household" : "not-a-member" };
  }

  if (thing.visibility === "household") return { ok: true };

  // An owner may see a supervised member's things, and only theirs. This is the
  // one asymmetry in the model, it is narrow, and the supervised person is told
  // it exists.
  const owner = activeMembership(question.memberships, thing.householdId, viewerUserId);
  const subject = activeMembership(question.memberships, thing.householdId, thing.ownerUserId);
  if (owner?.role === "owner" && subject?.role === "supervised") return { ok: true };

  return { ok: false, reason: "private-to-someone-else" };
}

function activeMembership(
  memberships: readonly Membership[],
  householdId: string,
  userId: string
): Membership | undefined {
  return memberships.find(
    (membership) =>
      membership.householdId === householdId &&
      membership.userId === userId &&
      membership.removedAt === undefined
  );
}

/**
 * Narrow a set of things to what a viewer may see.
 *
 * The query-level version of the same rule, and the one that actually matters:
 * a list filtered in the interface is a list that was fetched, and anything
 * fetched can be logged, cached, or sent to a model. Filtering here means the
 * other person's tasks are never in the result at all.
 */
export function visibleTo<T extends OwnedThing>(
  things: readonly T[],
  viewerUserId: string,
  memberships: readonly Membership[]
): readonly T[] {
  return things.filter((thing) => canAccess({ thing, viewerUserId, memberships }).ok);
}

export type ShareRefusal = "not-the-owner" | "no-household" | "not-a-member";

export type ShareDecision =
  | { readonly ok: true; readonly thing: OwnedThing }
  | { readonly ok: false; readonly reason: ShareRefusal; readonly message: string };

/**
 * Share something with the household.
 *
 * Only its owner can, and only into a household they are actually in. An owner
 * of the household cannot reach into someone's private things and publish them —
 * that would make "private" mean "private unless someone with a title decides
 * otherwise", which is not what the word does for the person relying on it.
 */
export function share(
  thing: OwnedThing,
  actorUserId: string,
  householdId: string,
  memberships: readonly Membership[]
): ShareDecision {
  if (thing.ownerUserId !== actorUserId) {
    return {
      ok: false,
      reason: "not-the-owner",
      message: "Only the person this belongs to can share it.",
    };
  }
  if (!activeMembership(memberships, householdId, actorUserId)) {
    return {
      ok: false,
      reason: "not-a-member",
      message: "You are not in that household.",
    };
  }

  return { ok: true, thing: { ...thing, householdId, visibility: "household" } };
}

/** Take something back out of the shared space. Always available to its owner. */
export function unshare(thing: OwnedThing, actorUserId: string): ShareDecision {
  if (thing.ownerUserId !== actorUserId) {
    return {
      ok: false,
      reason: "not-the-owner",
      message: "Only the person this belongs to can stop sharing it.",
    };
  }
  return { ok: true, thing: { ...thing, visibility: "private" } };
}

/**
 * Remove someone from a household.
 *
 * Their own things go with them: nothing they created privately becomes visible,
 * and nothing they created is deleted. A household is a place people leave, and
 * the software should make that unremarkable rather than destructive.
 */
export function removeMember(membership: Membership, now: number): Membership {
  return membership.removedAt === undefined ? { ...membership, removedAt: now } : membership;
}

/**
 * What a supervised member is told, in plain words, when supervision starts.
 *
 * Non-negotiable and unmissable. Monitoring someone who does not know they are
 * monitored is a different product with a different name, and a household
 * assistant should never be quietly usable as one.
 */
export function supervisionNotice(ownerLabel: string): string {
  return (
    `${ownerLabel} can see the tasks you ask me to do and what came of them. ` +
    `They cannot see your saved passwords or cards. ` +
    `I will tell you if this changes, and you can ask me about it at any time.`
  );
}

export function explainAccessRefusal(reason: AccessRefusal): string {
  switch (reason) {
    case "not-a-member":
    case "different-household":
      return "That belongs to a household you are not in.";
    case "private-to-someone-else":
      return "That is private to someone else.";
    case "removed-from-household":
      return "You are no longer in that household.";
  }
}
