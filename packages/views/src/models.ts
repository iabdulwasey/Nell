/**
 * Model settings — bring your own key.
 *
 * The screen where a self-hoster points Nell at whatever they have access to:
 * a frontier API, a cheaper provider, or something on their own hardware. This
 * is not a nice-to-have. An open agent that only works against one vendor's API
 * is that vendor's client program, and the user who wanted to run their own
 * assistant has bought a subscription with extra steps.
 *
 * Two things this module is careful about.
 *
 * **A key is a credential.** It goes to the server and never comes back. The
 * screen shows enough to tell two keys apart — the provider and the last four
 * characters — and nothing that could be used. A settings page that round-trips
 * a key so the input can be pre-filled has put a live credential in the DOM of
 * every browser the user has ever opened the page in.
 *
 * **A misconfiguration is caught here, not mid-task.** A model with no vision
 * cannot drive a computer, and discovering that when a worker is three steps
 * into a booking is a task that fails for a reason nobody can see. The problems
 * are surfaced on the screen where the choice is made.
 */

import {
  optionsForTier,
  validateCatalog,
  explainProblem,
  type CatalogEntry,
  type CatalogSelection,
  type ModelTier,
  type Provider,
} from "@nell/agent";

export interface StoredKey {
  readonly provider: Provider;
  /** Last four characters, for telling two keys apart. Never more. */
  readonly hint: string;
  readonly addedAt: number;
}

export interface ModelOption {
  readonly id: string;
  readonly provider: Provider;
  readonly displayName: string;
  readonly supportsVision: boolean;
  /** Rendered price, e.g. "$5.00 / $25.00 per million". */
  readonly price: string;
  /** True when this deployment has no key for the provider. */
  readonly needsKey: boolean;
  /**
   * Set when the option cannot serve the tier being chosen. Present rather than
   * hidden: a user looking for DeepSeek should be told why it is unavailable
   * here, not left wondering whether the list is broken.
   */
  readonly unavailableBecause?: string;
}

export interface TierPanel {
  readonly tier: ModelTier;
  readonly title: string;
  readonly explanation: string;
  readonly options: readonly ModelOption[];
  readonly selectedId?: string;
}

/** What each tier is for, in the user's terms rather than ours. */
const TIER_COPY: Readonly<Record<ModelTier, { title: string; explanation: string }>> = {
  nano: {
    title: "Quick decisions",
    explanation:
      "Sorting messages, deciding which task you meant, cheap checks that run constantly. " +
      "Runs thousands of times a day, so this is where a cheap model pays for itself.",
  },
  worker: {
    title: "Doing the work",
    explanation:
      "Driving your computer through a booking or a form. Most of what you notice happens here.",
  },
  frontier: {
    title: "Hard problems",
    explanation:
      "Reading the screen when a page will not cooperate, and untangling anything that went " +
      "wrong. Must be able to see images.",
  },
};

export function formatPrice(entry: CatalogEntry): string {
  if (entry.inputCostPerMillion === 0 && entry.outputCostPerMillion === 0) {
    return "your hardware";
  }
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  return `${dollars(entry.inputCostPerMillion)} in / ${dollars(entry.outputCostPerMillion)} out per million tokens`;
}

/**
 * Build the panel for one tier.
 *
 * Options a user cannot pick are shown with the reason rather than filtered
 * away. A list that silently omits things is a list a user cannot trust they
 * have read.
 */
export function tierPanel(
  tier: ModelTier,
  catalog: readonly CatalogEntry[],
  keys: readonly StoredKey[],
  selectedId?: string
): TierPanel {
  const withKeys = new Set(keys.map((key) => key.provider));
  const suitable = new Set(optionsForTier(catalog, tier).map((entry) => entry.id));

  const options = catalog.map((entry): ModelOption => {
    const unavailable = !suitable.has(entry.id)
      ? tier === "frontier" && !entry.supportsVision
        ? "Cannot see images, so it cannot read a screen when a page will not cooperate."
        : `Not a sensible choice for ${TIER_COPY[tier].title.toLowerCase()}.`
      : undefined;

    return {
      id: entry.id,
      provider: entry.provider,
      displayName: entry.displayName,
      supportsVision: entry.supportsVision,
      price: formatPrice(entry),
      // Self-hosted models are reached over a local endpoint, not an API key.
      needsKey: entry.provider !== "self-hosted" && !withKeys.has(entry.provider),
      unavailableBecause: unavailable,
    };
  });

  return {
    tier,
    title: TIER_COPY[tier].title,
    explanation: TIER_COPY[tier].explanation,
    options,
    selectedId,
  };
}

export interface SettingsProblem {
  readonly severity: "blocking" | "warning";
  readonly message: string;
}

/**
 * Everything wrong with the current configuration, in the order it matters.
 *
 * Blocking problems mean the agent cannot run. Warnings mean it will run and
 * something will surprise the user later — a provider with no key fails on the
 * first task, which is worse than failing on the settings screen.
 */
export function settingsProblems(
  selection: CatalogSelection | undefined,
  keys: readonly StoredKey[]
): readonly SettingsProblem[] {
  if (!selection) {
    return [{ severity: "blocking", message: "Pick a model for each of the three tiers." }];
  }

  const problems: SettingsProblem[] = validateCatalog(selection).map((problem) => ({
    severity: "blocking" as const,
    message: explainProblem(problem),
  }));

  const withKeys = new Set(keys.map((key) => key.provider));
  const seen = new Set<string>();

  for (const tier of ["nano", "worker", "frontier"] as const) {
    const entry = selection[tier];
    if (entry.provider === "self-hosted" || withKeys.has(entry.provider)) continue;
    if (seen.has(entry.provider)) continue;
    seen.add(entry.provider);

    problems.push({
      severity: "warning",
      message: `No API key for ${entry.provider}. ${entry.displayName} will fail on the first task that needs it.`,
    });
  }

  return problems;
}

/**
 * Prepare a key for storage and for display.
 *
 * The hint is the last four characters — enough to distinguish two keys from the
 * same provider, useless to anyone who obtains it. The key itself is returned
 * separately so a caller cannot accidentally persist the whole record into
 * something that ends up on a screen.
 */
export function describeKey(provider: Provider, key: string, now: number): StoredKey {
  const trimmed = key.trim();
  return {
    provider,
    hint: trimmed.length <= 4 ? "…" : `…${trimmed.slice(-4)}`,
    addedAt: now,
  };
}

/**
 * Whether a key is plausibly a key, before it is stored.
 *
 * Not validation of the credential — only the provider can say that — but
 * catching an empty box or a pasted URL here means the user learns immediately
 * rather than when their first task dies.
 */
export function looksLikeKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed.length < 16 || trimmed.length > 400) return false;
  if (/\s/u.test(trimmed)) return false;
  // Someone pasting a dashboard URL instead of the key is a common mistake.
  return !/^https?:/iu.test(trimmed);
}

/**
 * Estimate what a configuration costs to run.
 *
 * Rough by construction and labelled as such. The point is not accuracy — token
 * counts vary enormously by task — it is that a user choosing between a frontier
 * model and a local one can see the difference is two orders of magnitude, not
 * a rounding error, before they commit.
 */
export function estimateMonthlyCost(
  selection: CatalogSelection,
  tasksPerMonth: number
): { readonly minorUnits: number; readonly caveat: string } {
  // Measured shape of a browsing task: the worker does most of the work, the
  // nano tier runs constantly on tiny inputs, frontier is an escalation.
  const perTask = [
    { entry: selection.nano, inputK: 20, outputK: 1 },
    { entry: selection.worker, inputK: 180, outputK: 12 },
    { entry: selection.frontier, inputK: 30, outputK: 3 },
  ];

  const minorUnits = perTask.reduce((sum, { entry, inputK, outputK }) => {
    const input = (entry.inputCostPerMillion * inputK) / 1000;
    const output = (entry.outputCostPerMillion * outputK) / 1000;
    return sum + input + output;
  }, 0);

  return {
    minorUnits: Math.round(minorUnits * tasksPerMonth),
    caveat:
      "A rough estimate from a typical browsing task. Real usage varies a lot with how " +
      "stubborn a site is.",
  };
}
