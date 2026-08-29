/**
 * Merchant recipes.
 *
 * A recipe is a reviewed, human-authored sequence of typed actions for a task a
 * lot of people do on one site: book a table, check in for a flight, cancel a
 * subscription. When one exists, a worker follows it instead of rediscovering
 * the site from a screenshot — faster, cheaper, and dramatically more reliable
 * on the flows that matter.
 *
 * The reason to build this rather than lean on the model getting better: **a
 * recipe is the one asset that compounds across every install.** One person hits
 * a broken step on a restaurant site, the fix is reviewed once, and every
 * self-hoster and every hosted user gets it. A closed competitor cannot accept
 * that contribution without opening their agent, and an agent with no shared
 * playbooks re-derives the same site a million times.
 *
 * Three boundaries this file is strict about, because a recipe system is an
 * obvious place to accidentally reintroduce everything the DSL removed:
 *
 * 1. **A recipe is data, not code.** Steps are the same typed actions a model
 *    may emit. There is no scripting hook, no eval, no callback. Reviewed
 *    authorship buys specificity, not new powers.
 *
 * 2. **A recipe is a suggestion of steps, never an authorization.** Every action
 *    still goes through the policy chokepoint. A recipe that walks to a checkout
 *    still meets the spend gate there, and one that reaches a login still meets
 *    the origin allowlist. Being reviewed is not being trusted with someone's
 *    money.
 *
 * 3. **A recipe carries no user data.** These are public artefacts, shipped in
 *    the repo and contributed to by strangers. Values come from task parameters
 *    at instantiation time; a recipe containing a name, an address, or a
 *    credential is a bug, and `validateRecipe` treats it as one.
 */

import { z } from "zod";
import { normalizeOrigin } from "@nell/aegis";
import { actionSchema, type BrowserAction } from "@nell/browser";

/** What a recipe knows how to accomplish. */
export const recipeIntentSchema = z.enum([
  "book-table",
  "cancel-subscription",
  "check-in-flight",
  "track-order",
  "pay-bill",
  "find-availability",
]);

export type RecipeIntent = z.infer<typeof recipeIntentSchema>;

/**
 * A parameter a recipe needs filled in.
 *
 * Typed rather than free-form so instantiation can validate before a value ever
 * reaches a page. A party size that is not a number should fail here, not three
 * steps into a booking.
 */
export const recipeParamSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/u)
    .max(40),
  kind: z.enum(["text", "number", "date", "time", "email", "phone"]),
  required: z.boolean().default(true),
  /** Shown to the user when the agent has to ask. */
  prompt: z.string().max(200),
});

export type RecipeParam = z.infer<typeof recipeParamSchema>;

export const recipeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/u)
    .max(80),
  name: z.string().max(120),
  /**
   * Origins this recipe applies to. Exact, and used to bound every navigation
   * the recipe performs.
   */
  origins: z.array(z.url()).min(1).max(10),
  intent: recipeIntentSchema,
  /** Bumped whenever steps change, so a cached plan is never silently stale. */
  version: z.number().int().positive(),
  params: z.array(recipeParamSchema).max(12).default([]),
  /**
   * The steps. Placeholders are written `{{paramName}}` and substituted at
   * instantiation.
   */
  steps: z.array(actionSchema).min(1).max(40),
  /**
   * Text that should be visible when the recipe has done its job. Checked by the
   * eval harness, and by the worker before it reports success — "I clicked the
   * button" is not the same as "the booking exists".
   */
  succeedsWhen: z.array(z.string().min(2).max(200)).min(1).max(5),
  /** Who to blame, and where the review happened. */
  contributedBy: z.string().max(120).optional(),
});

export type Recipe = z.infer<typeof recipeSchema>;

export type RecipeProblem =
  | { readonly kind: "navigates-off-site"; readonly url: string }
  | { readonly kind: "contains-user-data"; readonly detail: string }
  | { readonly kind: "unknown-placeholder"; readonly name: string }
  | { readonly kind: "unused-param"; readonly name: string };

/** Values that look like a person rather than like a template. */
const USER_DATA_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/u, "an email address"],
  [/\b(?:\d[ -]?){13,19}\b/u, "something shaped like a card number"],
  [/\b\d{3}[ -]?\d{2}[ -]?\d{4}\b/u, "something shaped like a national ID"],
  [
    /\b(?:\+\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/u,
    "something shaped like a phone number",
  ],
];

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/gu;

/**
 * Check a recipe before it is allowed anywhere near a session.
 *
 * This is the review gate expressed as code. A contributor is a stranger, and
 * "we reviewed it" is not a property a build can check — these are.
 */
export function validateRecipe(recipe: Recipe): readonly RecipeProblem[] {
  const problems: RecipeProblem[] = [];
  const allowed = new Set(recipe.origins.map((origin) => normalizeOrigin(origin)));
  const declared = new Set(recipe.params.map((param) => param.name));
  const used = new Set<string>();

  for (const step of recipe.steps) {
    // A navigation is the one step that can leave the site the user agreed to.
    // Without this, a recipe for a restaurant could walk a signed-in browser
    // anywhere at all.
    if (step.action === "goto") {
      const target = normalizeOrigin(step.url);
      if (!target || !allowed.has(target)) {
        problems.push({ kind: "navigates-off-site", url: step.url });
      }
    }

    for (const value of literalsOf(step)) {
      for (const match of value.matchAll(PLACEHOLDER)) {
        const param = match[1];
        if (param) used.add(param);
      }

      // A placeholder is a template; a literal that looks like a person is not.
      const withoutPlaceholders = value.replaceAll(PLACEHOLDER, "");
      for (const [pattern, description] of USER_DATA_PATTERNS) {
        if (pattern.test(withoutPlaceholders)) {
          problems.push({ kind: "contains-user-data", detail: description });
        }
      }
    }
  }

  for (const name of used) {
    if (!declared.has(name)) problems.push({ kind: "unknown-placeholder", name });
  }
  for (const name of declared) {
    if (!used.has(name)) problems.push({ kind: "unused-param", name });
  }

  return problems;
}

export function explainRecipeProblem(problem: RecipeProblem): string {
  switch (problem.kind) {
    case "navigates-off-site":
      return `Step navigates to ${problem.url}, which is outside the origins this recipe declares.`;
    case "contains-user-data":
      return `A step contains ${problem.detail}. Recipes are public and must carry no user data.`;
    case "unknown-placeholder":
      return `Step references {{${problem.name}}}, which the recipe does not declare as a parameter.`;
    case "unused-param":
      return `Parameter "${problem.name}" is declared but never used.`;
  }
}

export type InstantiateOutcome =
  | { readonly ok: true; readonly actions: readonly BrowserAction[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Turn a recipe into a concrete action batch.
 *
 * Parameters are validated against their declared kind first. A value only ever
 * lands inside a typed field of a typed action, so it cannot change what an
 * action *is* — but a party size of "; DROP TABLE" reaching a page is still a
 * bad afternoon, and rejecting it here means the failure is a clear error rather
 * than a confusing one four steps later.
 */
export function instantiate(
  recipe: Recipe,
  params: Readonly<Record<string, string>>
): InstantiateOutcome {
  for (const declared of recipe.params) {
    const value = params[declared.name];
    if (value === undefined || value.trim() === "") {
      if (declared.required) {
        return { ok: false, reason: `Missing required parameter "${declared.name}".` };
      }
      continue;
    }
    if (!matchesKind(value, declared.kind)) {
      return {
        ok: false,
        reason: `Parameter "${declared.name}" is not a valid ${declared.kind}.`,
      };
    }
  }

  const substitute = (text: string): string =>
    text.replaceAll(PLACEHOLDER, (match, name: string) => params[name] ?? match);

  const actions = recipe.steps.map((step) => substituteIn(step, substitute));

  // Defence in depth, and worth being honest that it is not the guarantee: a
  // fully templated destination cannot be authored in the first place, because
  // `goto` validates its URL as real http(s) and `{{path}}` is not one. What
  // survives authoring is a placeholder inside a path, where the origin is
  // already fixed. This re-check exists for the next action type that carries a
  // URL, added by someone who has not read this file.
  const allowed = new Set(recipe.origins.map((origin) => normalizeOrigin(origin)));
  for (const action of actions) {
    if (action.action !== "goto") continue;
    const target = normalizeOrigin(action.url);
    if (!target || !allowed.has(target)) {
      return { ok: false, reason: `A parameter redirected this recipe to ${action.url}.` };
    }
  }

  return { ok: true, actions };
}

function matchesKind(value: string, kind: RecipeParam["kind"]): boolean {
  switch (kind) {
    case "number":
      return /^\d{1,6}$/u.test(value);
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/u.test(value);
    case "time":
      return /^\d{2}:\d{2}$/u.test(value);
    case "email":
      return z.string().email().safeParse(value).success;
    case "phone":
      return /^\+?[\d ()-]{7,20}$/u.test(value);
    case "text":
      // Control characters have no business in a form field and are a common
      // way to smuggle something past a naive renderer.
      return value.length <= 300 && !/[ -]/u.test(value);
  }
}

/** Every literal string a step carries, for scanning and substitution. */
function literalsOf(step: BrowserAction): readonly string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") values.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(step);
  return values;
}

function substituteIn(step: BrowserAction, substitute: (text: string) => string): BrowserAction {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return substitute(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, walk(val)]));
    }
    return value;
  };
  return walk(step) as BrowserAction;
}

/**
 * Find a recipe for what the worker is about to do.
 *
 * Origin AND intent must both match. Matching on origin alone would hand a
 * cancel-subscription recipe to a task that meant to check an order, which is
 * the kind of confident wrongness that is worse than having no recipe at all.
 */
export function selectRecipe(
  recipes: readonly Recipe[],
  origin: string,
  intent: RecipeIntent
): Recipe | undefined {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return undefined;

  const matches = recipes.filter(
    (recipe) =>
      recipe.intent === intent &&
      recipe.origins.some((candidate) => normalizeOrigin(candidate) === normalized)
  );

  // Highest version wins, so a fixed recipe supersedes the one it fixed.
  return matches.sort((a, b) => b.version - a.version)[0];
}

/**
 * Whether the page shows what the recipe said success looks like.
 *
 * The distinction this enforces: "I clicked the button" is not "the booking
 * exists". An agent that reports success on having performed the steps is the
 * one that tells a user their table is booked when the site threw an error.
 */
export function succeeded(recipe: Recipe, pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return recipe.succeedsWhen.every((marker) => haystack.includes(marker.toLowerCase()));
}
