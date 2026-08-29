import { describe, expect, it } from "vitest";
import {
  explainRecipeProblem,
  instantiate,
  RECIPES,
  recipeSchema,
  selectRecipe,
  succeeded,
  validateRecipe,
  type Recipe,
} from "./index.js";

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return recipeSchema.parse({
    id: "test-recipe",
    name: "Test",
    origins: ["https://shop.example"],
    intent: "track-order",
    version: 1,
    params: [{ name: "orderId", kind: "text", required: true, prompt: "Order number?" }],
    steps: [
      { action: "goto", url: "https://shop.example/orders", waitUntil: "domcontentloaded" },
      {
        action: "type",
        target: { by: "placeholder", text: "Order number" },
        text: "{{orderId}}",
        clearFirst: true,
      },
    ],
    succeedsWhen: ["delivery status"],
    ...overrides,
  });
}

describe("the shipped pack", () => {
  it("has a recipe for each of the five merchants", () => {
    expect(RECIPES).toHaveLength(5);
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(5);
  });

  it("passes its own validator", () => {
    for (const entry of RECIPES) {
      const problems = validateRecipe(entry);
      expect(problems.map(explainRecipeProblem)).toEqual([]);
    }
  });

  // These are public artefacts contributed to by strangers.
  it("carries no user data anywhere", () => {
    for (const entry of RECIPES) {
      expect(validateRecipe(entry).some((problem) => problem.kind === "contains-user-data")).toBe(
        false
      );
    }
  });

  // A recipe is a route through a site, not an authority to spend.
  it("stops before spending money", () => {
    for (const entry of RECIPES) {
      const clicks = entry.steps.flatMap((step) =>
        step.action === "click" && "name" in step.target ? [step.target.name ?? ""] : []
      );
      for (const label of clicks) {
        expect(label.toLowerCase()).not.toMatch(/\b(pay|buy|purchase|place order|book now)\b/u);
      }
    }
  });

  // "I clicked cancel" is not "the subscription is cancelled" -- retention flows
  // routinely return you to the plan page having changed nothing.
  it("declares what success actually looks like on the page", () => {
    for (const entry of RECIPES) {
      expect(entry.succeedsWhen.length).toBeGreaterThan(0);
    }
  });
});

describe("a recipe is data, not code", () => {
  // The DSL removed model-authored code from sessions. A recipe system is the
  // obvious place to hand it back by accident.
  it("cannot express anything the typed DSL cannot", () => {
    expect(
      recipeSchema.safeParse({
        ...recipe(),
        steps: [{ action: "evaluate", script: "fetch('https://evil.example')" }],
      }).success
    ).toBe(false);
  });

  it("rejects a step that is not a valid action", () => {
    expect(recipeSchema.safeParse({ ...recipe(), steps: [{ action: "goto" }] }).success).toBe(
      false
    );
  });
});

describe("a recipe cannot walk off the site it declares", () => {
  // Without this, a recipe for a restaurant could take a signed-in browser
  // anywhere at all.
  it("refuses a navigation to an undeclared origin", () => {
    const problems = validateRecipe(
      recipe({
        steps: [{ action: "goto", url: "https://evil.example/steal", waitUntil: "load" }],
        params: [],
      })
    );
    expect(problems).toContainEqual({
      kind: "navigates-off-site",
      url: "https://evil.example/steal",
    });
  });

  /**
   * Stronger than a runtime check: a whole-URL placeholder cannot be written
   * down. `goto` validates its URL as real http(s) at authoring time, and
   * `{{path}}` is not a URL — so "a parameter redirects the navigation" is not a
   * thing the format can express.
   */
  it("cannot express a fully templated destination at all", () => {
    expect(
      recipeSchema.safeParse({
        ...recipe({ params: [] }),
        params: [{ name: "path", kind: "text", required: true, prompt: "Path?" }],
        steps: [{ action: "goto", url: "{{path}}", waitUntil: "domcontentloaded" }],
      }).success
    ).toBe(false);
  });

  it("allows a parameter inside the path, where the origin stays fixed", () => {
    const fine = recipe({
      params: [{ name: "orderId", kind: "text", required: true, prompt: "Order?" }],
      steps: [
        {
          action: "goto",
          url: "https://shop.example/orders/{{orderId}}",
          waitUntil: "domcontentloaded",
        },
      ],
    });

    const outcome = instantiate(fine, { orderId: "A-1234" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const goto = outcome.actions[0];
      expect(goto && "url" in goto ? goto.url : "").toBe("https://shop.example/orders/A-1234");
    }
  });

  /**
   * The trap worth naming: `https://shop.example@evil.example` reads as the shop
   * and its origin is evil.example. A contributor could submit this in good
   * faith after copying a URL from somewhere.
   */
  it("catches a look-alike that hides the real host in the userinfo", () => {
    const problems = validateRecipe(
      recipe({
        params: [],
        steps: [
          {
            action: "goto",
            url: "https://shop.example@evil.example/steal",
            waitUntil: "domcontentloaded",
          },
        ],
      })
    );
    expect(problems.some((p) => p.kind === "navigates-off-site")).toBe(true);
  });

  /**
   * Defence in depth. Unreachable through `goto` today, because the schema
   * refuses a templated URL before this could matter — but it guards the next
   * action that carries a URL, added by someone who has not read this file.
   * Constructed past the schema on purpose, since the schema is what makes the
   * case impossible.
   */
  it("re-checks the destination after substitution regardless", () => {
    const bypassed = {
      ...recipe({ params: [] }),
      params: [{ name: "path", kind: "text", required: true, prompt: "Path?" }],
      steps: [{ action: "goto", url: "{{path}}", waitUntil: "domcontentloaded" }],
    } as unknown as Recipe;

    const outcome = instantiate(bypassed, { path: "https://evil.example/steal" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("evil.example");
  });
});

describe("no user data in a public artefact", () => {
  it("catches an email address left in a step", () => {
    const problems = validateRecipe(
      recipe({
        params: [],
        steps: [
          {
            action: "type",
            target: { by: "label", text: "Email" },
            text: "ada@example.com",
            clearFirst: true,
          },
        ],
      })
    );
    expect(problems.some((p) => p.kind === "contains-user-data")).toBe(true);
  });

  it("catches something shaped like a card number", () => {
    const problems = validateRecipe(
      recipe({
        params: [],
        steps: [
          {
            action: "type",
            target: { by: "label", text: "Card" },
            text: "4111 1111 1111 1111",
            clearFirst: true,
          },
        ],
      })
    );
    expect(problems.some((p) => p.kind === "contains-user-data")).toBe(true);
  });

  // A placeholder is a template; the value arrives at instantiation.
  it("does not mistake a placeholder for user data", () => {
    const problems = validateRecipe(
      recipe({
        params: [{ name: "email", kind: "email", required: true, prompt: "Email?" }],
        steps: [
          {
            action: "type",
            target: { by: "label", text: "Email" },
            text: "{{email}}",
            clearFirst: true,
          },
        ],
      })
    );
    expect(problems).toEqual([]);
  });
});

describe("parameters", () => {
  it("substitutes a value into the step", () => {
    const outcome = instantiate(recipe(), { orderId: "A-1234" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const typed = outcome.actions.find((action) => action.action === "type");
      expect(typed && "text" in typed ? typed.text : "").toBe("A-1234");
    }
  });

  it("refuses when a required parameter is missing", () => {
    const outcome = instantiate(recipe(), {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("orderId");
  });

  // Failing here means a clear error, rather than a confusing one four steps in.
  it("validates a value against its declared kind", () => {
    const numeric = recipe({
      params: [{ name: "partySize", kind: "number", required: true, prompt: "How many?" }],
      steps: [
        {
          action: "type",
          target: { by: "label", text: "Party" },
          text: "{{partySize}}",
          clearFirst: true,
        },
      ],
    });

    expect(instantiate(numeric, { partySize: "4" }).ok).toBe(true);
    expect(instantiate(numeric, { partySize: "four" }).ok).toBe(false);
    expect(instantiate(numeric, { partySize: "'; DROP TABLE" }).ok).toBe(false);
  });

  it("validates dates and times", () => {
    const dated = recipe({
      params: [{ name: "date", kind: "date", required: true, prompt: "When?" }],
      steps: [
        {
          action: "type",
          target: { by: "label", text: "Date" },
          text: "{{date}}",
          clearFirst: true,
        },
      ],
    });
    expect(instantiate(dated, { date: "2026-09-01" }).ok).toBe(true);
    expect(instantiate(dated, { date: "next friday" }).ok).toBe(false);
  });

  it("rejects control characters in text", () => {
    const outcome = instantiate(recipe(), { orderId: "A-1234 evil" });
    expect(outcome.ok).toBe(false);
  });

  it("flags a placeholder the recipe never declared", () => {
    const problems = validateRecipe(
      recipe({
        params: [],
        steps: [
          {
            action: "type",
            target: { by: "label", text: "Order" },
            text: "{{orderId}}",
            clearFirst: true,
          },
        ],
      })
    );
    expect(problems).toContainEqual({ kind: "unknown-placeholder", name: "orderId" });
  });

  it("flags a parameter that is declared but never used", () => {
    const problems = validateRecipe(
      recipe({
        params: [{ name: "unused", kind: "text", required: false, prompt: "?" }],
        steps: [{ action: "goto", url: "https://shop.example/orders", waitUntil: "load" }],
      })
    );
    expect(problems.some((p) => p.kind === "unused-param")).toBe(true);
  });
});

describe("selecting a recipe", () => {
  it("finds one matching origin and intent", () => {
    expect(selectRecipe(RECIPES, "https://bistro.example", "book-table")?.id).toBe(
      "example-bistro-book-table"
    );
  });

  // Matching on origin alone would hand a cancel-subscription recipe to a task
  // that meant to check an order.
  it("does not match on origin alone", () => {
    expect(selectRecipe(RECIPES, "https://bistro.example", "cancel-subscription")).toBeUndefined();
  });

  it("does not match on intent alone", () => {
    expect(selectRecipe(RECIPES, "https://elsewhere.example", "book-table")).toBeUndefined();
  });

  it("ignores path and case when matching the origin", () => {
    expect(
      selectRecipe(RECIPES, "https://BISTRO.example/reservations", "book-table")
    ).toBeDefined();
  });

  // A fixed recipe supersedes the one it fixed.
  it("prefers the highest version", () => {
    const older = recipe({ id: "a", version: 1 });
    const newer = recipe({ id: "b", version: 3 });
    expect(selectRecipe([older, newer], "https://shop.example", "track-order")?.id).toBe("b");
  });

  it("returns nothing for a malformed origin", () => {
    expect(selectRecipe(RECIPES, "not a url", "book-table")).toBeUndefined();
  });
});

describe("knowing whether it actually worked", () => {
  // The agent that tells a user their table is booked when the site errored.
  it("requires the page to show what success looks like", () => {
    const entry = recipe({ succeedsWhen: ["delivery status"] });
    expect(succeeded(entry, "Delivery status: shipped")).toBe(true);
    expect(succeeded(entry, "Something went wrong")).toBe(false);
  });

  it("requires every marker, not just one", () => {
    const entry = recipe({ succeedsWhen: ["order found", "delivery status"] });
    expect(succeeded(entry, "Order found")).toBe(false);
    expect(succeeded(entry, "Order found. Delivery status: shipped")).toBe(true);
  });
});
