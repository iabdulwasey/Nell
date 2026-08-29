/**
 * The starter pack.
 *
 * Five merchants across the shapes that matter: a booking, a cancellation, a
 * check-in, an order lookup, and a bill payment. They are written against
 * example domains rather than real sites, because a recipe pinned to a real
 * site's markup is wrong the week that site redesigns, and shipping stale
 * selectors is worse than shipping none — a worker that follows a broken recipe
 * confidently does the wrong thing, where one with no recipe would have looked.
 *
 * What these are for, concretely: they establish the shape a contributor copies,
 * and they give the validator and the eval harness something real to run
 * against. The pack grows by contribution, which is the whole point of it being
 * public.
 *
 * Note what none of them contain: a credential, an address, a name, a card. A
 * recipe is a route through a site, not a filled-in form.
 */

import { recipeSchema, type Recipe } from "./recipe.js";

export const RECIPES: readonly Recipe[] = [
  {
    id: "example-bistro-book-table",
    name: "Book a table at Example Bistro",
    origins: ["https://bistro.example"],
    intent: "book-table",
    version: 1,
    params: [
      { name: "date", kind: "date", required: true, prompt: "Which date?" },
      { name: "time", kind: "time", required: true, prompt: "What time?" },
      { name: "partySize", kind: "number", required: true, prompt: "How many people?" },
    ],
    steps: [
      { action: "goto", url: "https://bistro.example/reservations", waitUntil: "domcontentloaded" },
      { action: "type", target: { by: "label", text: "Date" }, text: "{{date}}", clearFirst: true },
      { action: "type", target: { by: "label", text: "Time" }, text: "{{time}}", clearFirst: true },
      { action: "select", target: { by: "label", text: "Party size" }, value: "{{partySize}}" },
      { action: "click", target: { by: "role", role: "button", name: "Find a table" } },
      {
        action: "waitFor",
        target: { by: "text", text: "Available times" },
        state: "visible",
        timeoutMs: 10_000,
      },
      { action: "extract", fields: ["times", "price"] },
    ],
    // Stops at the choice. Picking a time and confirming spends money, which is
    // the user's decision and the spend gate's business, not the recipe's.
    succeedsWhen: ["available times"],
    contributedBy: "nell",
  },

  {
    id: "example-stream-cancel-subscription",
    name: "Cancel an Example Stream subscription",
    origins: ["https://stream.example"],
    intent: "cancel-subscription",
    version: 1,
    params: [],
    steps: [
      { action: "goto", url: "https://stream.example/account/plan", waitUntil: "domcontentloaded" },
      { action: "click", target: { by: "role", role: "link", name: "Manage plan" } },
      { action: "click", target: { by: "role", role: "button", name: "Cancel subscription" } },
      // Retention flows are the whole difficulty of cancelling: several screens,
      // each offering a discount, each with a differently-worded confirm.
      {
        action: "waitFor",
        target: { by: "text", text: "Continue to cancel" },
        state: "visible",
        timeoutMs: 10_000,
      },
      { action: "click", target: { by: "role", role: "button", name: "Continue to cancel" } },
      { action: "click", target: { by: "role", role: "button", name: "Confirm cancellation" } },
      { action: "extract", fields: ["confirmation", "endsOn"] },
    ],
    // "I clicked cancel" is not "the subscription is cancelled". Retention flows
    // routinely return you to the plan page having changed nothing.
    succeedsWhen: ["subscription cancelled"],
    contributedBy: "nell",
  },

  {
    id: "example-air-check-in",
    name: "Check in for an Example Air flight",
    origins: ["https://air.example"],
    intent: "check-in-flight",
    version: 1,
    params: [
      { name: "reference", kind: "text", required: true, prompt: "Booking reference?" },
      { name: "surname", kind: "text", required: true, prompt: "Surname on the booking?" },
    ],
    steps: [
      { action: "goto", url: "https://air.example/check-in", waitUntil: "domcontentloaded" },
      {
        action: "type",
        target: { by: "label", text: "Booking reference" },
        text: "{{reference}}",
        clearFirst: true,
      },
      {
        action: "type",
        target: { by: "label", text: "Surname" },
        text: "{{surname}}",
        clearFirst: true,
      },
      { action: "click", target: { by: "role", role: "button", name: "Continue" } },
      {
        action: "waitFor",
        target: { by: "text", text: "Boarding pass" },
        state: "visible",
        timeoutMs: 15_000,
      },
      { action: "extract", fields: ["seat", "gate", "boardingTime"] },
    ],
    succeedsWhen: ["boarding pass"],
    contributedBy: "nell",
  },

  {
    id: "example-shop-track-order",
    name: "Track an Example Shop order",
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
      { action: "press", key: "Enter" },
      {
        action: "waitFor",
        target: { by: "text", text: "Delivery status" },
        state: "visible",
        timeoutMs: 10_000,
      },
      { action: "extract", fields: ["status", "expectedDelivery", "carrier"] },
    ],
    succeedsWhen: ["delivery status"],
    contributedBy: "nell",
  },

  {
    id: "example-utility-pay-bill",
    name: "Review an Example Utility bill",
    origins: ["https://utility.example"],
    intent: "pay-bill",
    version: 1,
    params: [],
    steps: [
      { action: "goto", url: "https://utility.example/billing", waitUntil: "domcontentloaded" },
      {
        action: "waitFor",
        target: { by: "text", text: "Amount due" },
        state: "visible",
        timeoutMs: 10_000,
      },
      { action: "extract", fields: ["amountDue", "dueDate", "accountBalance"] },
    ],
    // Deliberately stops before paying. The recipe's job is to get the exact
    // amount in front of the approval gate; a recipe that pressed Pay would be a
    // reviewed script spending someone's money on its own authority.
    succeedsWhen: ["amount due"],
    contributedBy: "nell",
  },
].map((recipe) => recipeSchema.parse(recipe));
