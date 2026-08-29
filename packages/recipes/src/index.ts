/**
 * @nell/recipes
 *
 * Public, per-merchant browser playbooks containing no user data.
 *
 * The one asset that compounds across every install: a broken step is fixed
 * once and every self-hoster and hosted user gets it. A recipe is data, never
 * code, and never an authorization — every step it produces still meets the
 * policy chokepoint.
 *
 * Governed by: docs/architecture.md
 */

export {
  explainRecipeProblem,
  instantiate,
  recipeIntentSchema,
  recipeParamSchema,
  recipeSchema,
  selectRecipe,
  succeeded,
  validateRecipe,
  type InstantiateOutcome,
  type Recipe,
  type RecipeIntent,
  type RecipeParam,
  type RecipeProblem,
} from "./recipe.js";

export { RECIPES } from "./pack.js";

export {
  bestTrusted,
  canonicalForm,
  describeFallback,
  recipeDigest,
  signedRecipeSchema,
  signerSchema,
  trust,
  verifyRecipeSignature,
  type Revocation,
  type SignedRecipe,
  type Signer,
  type TrustDecision,
  type TrustFailure,
  type TrustOptions,
} from "./marketplace.js";
