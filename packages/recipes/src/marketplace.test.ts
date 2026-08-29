import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bestTrusted,
  canonicalForm,
  describeFallback,
  recipeDigest,
  recipeSchema,
  trust,
  verifyRecipeSignature,
  type Recipe,
  type Signer,
  type TrustOptions,
} from "./index.js";

const NOW = 1_700_000_000_000;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const reviewer = keypair();
const stranger = keypair();

const signer: Signer = {
  id: "nell-reviewers",
  label: "Nell reviewers",
  publicKeyPem: reviewer.publicKeyPem,
};

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return recipeSchema.parse({
    id: "shop-track-order",
    name: "Track an order",
    origins: ["https://shop.example"],
    intent: "track-order",
    version: 1,
    params: [],
    steps: [{ action: "goto", url: "https://shop.example/orders", waitUntil: "domcontentloaded" }],
    succeedsWhen: ["delivery status"],
    ...overrides,
  });
}

function signed(r: Recipe = recipe(), key = reviewer.privateKey, signerId = signer.id) {
  return {
    recipe: r,
    signerId,
    signature: signBytes(null, Buffer.from(canonicalForm(r), "utf8"), key).toString("base64"),
  };
}

function options(overrides: Partial<TrustOptions> = {}): TrustOptions {
  return { signers: [signer], revocations: [], ...overrides };
}

describe("signing covers the whole recipe", () => {
  it("accepts a recipe signed by a trusted reviewer", () => {
    const decision = trust(signed(), options());
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.signer.id).toBe("nell-reviewers");
  });

  /**
   * Signing a subset — the steps but not the origins, say — would leave the
   * unsigned part free to be edited by whoever served the file.
   */
  it("rejects a change to any field at all", () => {
    const original = signed();

    for (const tampered of [
      { ...original.recipe, origins: ["https://evil.example"] },
      { ...original.recipe, version: 99 },
      { ...original.recipe, succeedsWhen: ["anything"] },
      {
        ...original.recipe,
        steps: [{ action: "goto", url: "https://shop.example/other", waitUntil: "load" }],
      },
    ] as Recipe[]) {
      const decision = trust({ ...original, recipe: tampered }, options());
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.reason).toBe("bad-signature");
    }
  });

  it("rejects a signature from someone else's key", () => {
    const decision = trust(signed(recipe(), stranger.privateKey), options());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("bad-signature");
  });

  it("rejects a signer this install does not know", () => {
    const decision = trust(signed(recipe(), reviewer.privateKey, "someone-else"), options());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("unknown-signer");
  });

  // A self-hoster may add their own reviewer.
  it("accepts a signer the deployment chose to add", () => {
    const own: Signer = { id: "me", label: "Me", publicKeyPem: stranger.publicKeyPem };
    const decision = trust(
      signed(recipe(), stranger.privateKey, "me"),
      options({ signers: [signer, own] })
    );
    expect(decision.ok).toBe(true);
  });

  /**
   * There is no shape of bad input that should interrupt a task, and treating a
   * thrown error as anything other than "no" is how a verifier ends up
   * accepting one.
   */
  it("treats a malformed key or signature as a refusal, not an exception", () => {
    expect(verifyRecipeSignature(recipe(), "not-base64!!", signer)).toBe(false);
    expect(verifyRecipeSignature(recipe(), "AAAA", { ...signer, publicKeyPem: "not a key" })).toBe(
      false
    );
  });

  it("rejects something that is not a signed recipe", () => {
    for (const junk of [null, {}, { recipe: {} }, "a string", 42]) {
      const decision = trust(junk, options());
      expect(decision.ok).toBe(false);
      if (!decision.ok) expect(decision.reason).toBe("malformed");
    }
  });

  it("gives the same digest for the same recipe and a different one otherwise", () => {
    expect(recipeDigest(recipe())).toBe(recipeDigest(recipe()));
    expect(recipeDigest(recipe())).not.toBe(recipeDigest(recipe({ version: 2 })));
  });
});

describe("withdrawing a recipe", () => {
  it("refuses a version that was revoked", () => {
    const entry = signed();
    const decision = trust(
      entry,
      options({
        revocations: [
          {
            digest: recipeDigest(entry.recipe),
            reason: "It broke after a redesign",
            revokedAt: NOW,
          },
        ],
      })
    );

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("revoked");
      expect(decision.message).toContain("broke after a redesign");
    }
  });

  it("does not revoke a different version by accident", () => {
    const entry = signed(recipe({ version: 2 }));
    const decision = trust(
      entry,
      options({
        revocations: [{ digest: recipeDigest(recipe()), reason: "old one broke", revokedAt: NOW }],
      })
    );
    expect(decision.ok).toBe(true);
  });

  /**
   * A stale list cannot say what has been withdrawn, and a withdrawal is exactly
   * the case that matters. Refusing costs a little speed and nothing else.
   */
  it("refuses everything while the revocation list is stale", () => {
    const decision = trust(signed(), options({ revocationsStale: true }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toContain("could not check");
  });

  // The stronger fact is the more useful one to surface.
  it("reports a forged revoked recipe as forged", () => {
    const entry = signed(recipe(), stranger.privateKey);
    const decision = trust(
      entry,
      options({
        revocations: [{ digest: recipeDigest(entry.recipe), reason: "bad", revokedAt: NOW }],
      })
    );
    if (!decision.ok) expect(decision.reason).toBe("bad-signature");
  });
});

describe("pinning", () => {
  // For a deployment that would rather review updates than take them as they land.
  it("accepts only the versions an install pinned", () => {
    const entry = signed();
    expect(trust(entry, options({ pinnedDigests: [recipeDigest(entry.recipe)] })).ok).toBe(true);

    const decision = trust(entry, options({ pinnedDigests: ["some-other-digest"] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("not-pinned");
  });
});

describe("choosing among candidates", () => {
  it("takes the highest trusted version", () => {
    const best = bestTrusted([signed(recipe()), signed(recipe({ version: 3 }))], options());
    expect(best?.ok).toBe(true);
    if (best?.ok) expect(best.recipe.version).toBe(3);
  });

  /**
   * A marketplace containing one recipe this install does not trust is not a
   * problem, it is a Tuesday.
   */
  it("drops untrusted candidates silently rather than failing", () => {
    const best = bestTrusted(
      [signed(recipe({ version: 5 }), stranger.privateKey), signed(recipe({ version: 1 }))],
      options()
    );
    expect(best?.ok).toBe(true);
    if (best?.ok) expect(best.recipe.version).toBe(1);
  });

  it("returns nothing when none can be trusted", () => {
    expect(bestTrusted([signed(recipe(), stranger.privateKey)], options())).toBeUndefined();
    expect(bestTrusted([], options())).toBeUndefined();
  });
});

describe("failing closed is free here", () => {
  /**
   * The property the whole design rests on: a recipe is an optimisation, never a
   * capability. Anything a recipe does, the agent can do by looking at the page.
   * So every refusal costs speed and nothing else, which is why every ambiguous
   * case can fail closed without agonising over it.
   */
  it("says the task continues, not that something is wrong", () => {
    for (const reason of [
      "revoked",
      "not-pinned",
      "unknown-signer",
      "bad-signature",
      "malformed",
    ] as const) {
      const said = describeFallback(reason);
      expect(said).toContain("the long way");
      // Nothing that reads like a security incident for a missing shortcut.
      expect(said.toLowerCase()).not.toMatch(/attack|danger|warning|malicious/u);
    }
  });
});
