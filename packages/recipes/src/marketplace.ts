/**
 * The recipe marketplace.
 *
 * Recipes are the one asset that compounds across every install: someone hits a
 * broken step on a booking site, the fix is reviewed once, and everybody gets
 * it. That only works if strangers can contribute — and a stranger's recipe is
 * a sequence of actions that will be run against a browser holding the user's
 * logins.
 *
 * The existing guarantees do most of the work already: a recipe is data rather
 * than code, cannot navigate off the origins it declares, carries no user data,
 * and is never an authorization — every step it produces still meets the policy
 * chokepoint. What signing adds is the two things those cannot provide:
 * **provenance** (who reviewed this) and **revocation** (this turned out to be
 * bad, stop using it).
 *
 * One property makes this unusually easy to get right, and it is worth being
 * explicit about because it is the reason every decision below can be strict:
 *
 * **A recipe is an optimisation, never a capability.** Anything a recipe does,
 * the agent can do by looking at the page. So refusing a recipe costs speed and
 * nothing else — no task becomes impossible, no user is locked out. That means
 * every ambiguous case can fail closed without agonising over it: an unknown
 * signer, an unfetchable revocation list, a signature that does not verify, a
 * version that drifted. All of them fall back to driving the site normally,
 * which is what the agent would have done anyway.
 *
 * Most trust systems have to balance safety against availability. This one does
 * not, and the design should take the free lunch.
 */

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";
import { recipeSchema, type Recipe } from "./recipe.js";

/** A party whose review a deployment accepts. */
export const signerSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().max(120),
  /** Ed25519 public key, SPKI in PEM. */
  publicKeyPem: z.string().min(1),
});

export type Signer = z.infer<typeof signerSchema>;

export const signedRecipeSchema = z.object({
  recipe: recipeSchema,
  signerId: z.string().min(1).max(80),
  /** Base64 signature over the canonical form below. */
  signature: z.string().min(1).max(500),
});

export type SignedRecipe = z.infer<typeof signedRecipeSchema>;

/**
 * The exact bytes a signature covers.
 *
 * Canonical and total: every field of the recipe, with object keys sorted, so
 * the same recipe always produces the same bytes and any change at all produces
 * different ones. Signing a subset — the steps but not the origins, say — would
 * leave the unsigned part free to be edited by whoever served the file.
 */
export function canonicalForm(recipe: Recipe): string {
  return canonicalize(recipe);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`);

  return `{${entries.join(",")}}`;
}

/** Stable identity of a recipe version, for pinning and for revocation. */
export function recipeDigest(recipe: Recipe): string {
  return createHash("sha256").update(canonicalForm(recipe)).digest("hex");
}

export type TrustFailure =
  | "unknown-signer"
  | "bad-signature"
  | "revoked"
  | "not-pinned"
  | "malformed";

export type TrustDecision =
  | { readonly ok: true; readonly recipe: Recipe; readonly signer: Signer }
  | { readonly ok: false; readonly reason: TrustFailure; readonly message: string };

export interface Revocation {
  /** Digest of the exact recipe version withdrawn. */
  readonly digest: string;
  readonly reason: string;
  readonly revokedAt: number;
}

export interface TrustOptions {
  /** Signers this deployment accepts. A self-hoster may add their own. */
  readonly signers: readonly Signer[];
  readonly revocations: readonly Revocation[];
  /**
   * When set, only these exact versions are accepted. For a deployment that
   * would rather review updates itself than take them as they land.
   */
  readonly pinnedDigests?: readonly string[];
  /**
   * True when the revocation list could not be refreshed. Recipes are refused
   * while it is stale — see the module header on why that costs nothing.
   */
  readonly revocationsStale?: boolean;
}

/**
 * Decide whether to use a recipe someone else wrote.
 *
 * Every failure path returns the same practical outcome — the agent drives the
 * site normally — so the checks can be as strict as they like.
 */
export function trust(candidate: unknown, options: TrustOptions): TrustDecision {
  const parsed = signedRecipeSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "malformed",
      message: "That recipe is not in a shape I recognise, so I will just use the site directly.",
    };
  }

  const { recipe, signerId, signature } = parsed.data;
  const signer = options.signers.find((candidateSigner) => candidateSigner.id === signerId);

  if (!signer) {
    return {
      ok: false,
      reason: "unknown-signer",
      message: `That recipe was signed by ${signerId}, who is not someone this install trusts.`,
    };
  }

  if (!verifyRecipeSignature(recipe, signature, signer)) {
    return {
      ok: false,
      reason: "bad-signature",
      message: "That recipe has been altered since it was reviewed.",
    };
  }

  const digest = recipeDigest(recipe);

  // Checked after the signature, so a revoked-but-forged recipe is reported as
  // forged. The stronger fact is the more useful one to surface.
  const revocation = options.revocations.find((entry) => entry.digest === digest);
  if (revocation) {
    return {
      ok: false,
      reason: "revoked",
      message: `That recipe was withdrawn: ${revocation.reason}`,
    };
  }

  // A stale list cannot say what has been withdrawn, and a withdrawal is exactly
  // the case that matters. Refusing costs a little speed.
  if (options.revocationsStale) {
    return {
      ok: false,
      reason: "revoked",
      message: "I could not check whether that recipe is still current, so I am not using it.",
    };
  }

  if (options.pinnedDigests && !options.pinnedDigests.includes(digest)) {
    return {
      ok: false,
      reason: "not-pinned",
      message: "That is a newer version than this install has reviewed.",
    };
  }

  return { ok: true, recipe, signer };
}

/**
 * Verify a signature.
 *
 * Any failure — a malformed key, a corrupt signature, a wrong algorithm — is a
 * verification failure rather than an exception. There is no shape of bad input
 * here that should be able to interrupt a task, and treating a thrown error as
 * anything other than "no" is how a verifier ends up accepting one.
 */
export function verifyRecipeSignature(recipe: Recipe, signature: string, signer: Signer): boolean {
  try {
    const key = createPublicKey(signer.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;

    return verifySignature(
      null,
      Buffer.from(canonicalForm(recipe), "utf8"),
      key,
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

/**
 * Pick the best trusted recipe from a set of candidates.
 *
 * Untrusted candidates are dropped silently rather than reported as errors: a
 * marketplace containing one recipe this install does not trust is not a
 * problem, it is a Tuesday. Among the survivors the highest version wins, so a
 * fix supersedes what it fixed.
 */
export function bestTrusted(
  candidates: readonly unknown[],
  options: TrustOptions
): TrustDecision | undefined {
  const trusted = candidates
    .map((candidate) => trust(candidate, options))
    .filter((decision): decision is Extract<TrustDecision, { ok: true }> => decision.ok);

  if (trusted.length === 0) return undefined;

  return [...trusted].sort((a, b) => b.recipe.version - a.recipe.version)[0];
}

/**
 * What a user is told when a recipe was not used.
 *
 * Deliberately unalarming. Nothing has gone wrong from their point of view — the
 * task proceeds, slightly slower — and a warning that reads like a security
 * incident for something that is merely a missing optimisation teaches people to
 * ignore the ones that matter.
 */
export function describeFallback(reason: TrustFailure): string {
  switch (reason) {
    case "revoked":
      return "I am doing this the long way — the shortcut for this site has been withdrawn.";
    case "not-pinned":
      return "I am doing this the long way — there is a newer shortcut this install has not reviewed.";
    case "unknown-signer":
    case "bad-signature":
    case "malformed":
      return "I am doing this the long way — I could not verify the shortcut for this site.";
  }
}
