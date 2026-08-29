/**
 * What a model can actually do, and which model does what.
 *
 * The catalog has always recorded provider, price, tier and vision. None of
 * that answers the question a person asks when they pick a model: *what will my
 * assistant be able to do?* So the answer was computed at boot from whichever
 * keys happened to be present, never shown, and discovered only when something
 * failed — which is a bug report rather than a decision.
 *
 * Two ideas here, and they are separate on purpose.
 *
 * **A capability is something a model can do.** Reading a page of text, seeing a
 * picture, searching the live web, running code, drawing, hearing, embedding.
 * Whether a *vendor* offers it is a fact about that vendor, not about us, and it
 * changes when they ship — so it lives in the catalog beside the price.
 *
 * **An assignment says which model does which.** One model for everything is the
 * ordinary case and stays the default. A hosted or advanced install can send
 * drawing to one vendor and reasoning to another, which is the only way to get a
 * complete assistant when no single vendor does everything — and none does.
 *
 * `browse` is deliberately absent from both. Driving a real page is a property
 * of the deployment, not of a model, and it sits behind a different boundary:
 * the browser holds the user's logins and can spend their money, so everything
 * through it meets the spend gate and the taint machine. A model calling an
 * image API meets neither and needs to meet neither.
 */

import { z } from "zod";

export const modelCapabilitySchema = z.enum([
  /** Reads and writes text. Every model, and the reason it is not worth asking about. */
  "text",
  /** Can be shown a picture or a PDF page and reason about what is in it. */
  "vision",
  /** Searches the live web itself, server-side, without a browser. */
  "search",
  /** Writes and runs code in a sandbox, producing real files. */
  "code",
  /** Generates pictures. */
  "image",
  /** Hears speech, or speaks. */
  "audio",
  /** Produces embeddings, which the recall index needs. */
  "embed",
]);

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

/**
 * What each is for, in the words a settings screen should use.
 *
 * Written as what the user gets, not what the API is called: nobody picks a
 * model because it has "server-side tool use", they pick it because it can make
 * them a spreadsheet.
 */
export const CAPABILITY_LABELS: Readonly<Record<ModelCapability, string>> = {
  text: "Answer questions and write",
  vision: "Read documents, screenshots and photos",
  search: "Search the live web",
  code: "Run code, and produce files like PDFs and spreadsheets",
  image: "Generate images",
  audio: "Listen and speak",
  embed: "Remember and recall across conversations",
};

/**
 * Which vendor offers what, today.
 *
 * By vendor rather than by model, because these are platform features and move
 * together — when a vendor ships a sandbox, it ships for the models that
 * support tools, not for one of them. Per-model exceptions are recorded on the
 * catalog entry and win over this.
 *
 * This will go out of date. That is not a flaw to design around: it is a table
 * of somebody else's roadmap, it is one edit to correct, and being explicit
 * about which vendor can do what is the only way a settings screen can be
 * honest.
 */
/** How each vendor is written when a person reads it. */
export const VENDOR_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  zhipu: "Zhipu",
  moonshot: "Moonshot",
  mistral: "Mistral",
  openrouter: "OpenRouter",
  "self-hosted": "your own hardware",
};

export const VENDOR_CAPABILITIES: Readonly<Record<string, readonly ModelCapability[]>> = {
  anthropic: ["text", "vision", "search", "code"],
  openai: ["text", "vision", "search", "code", "image", "audio", "embed"],
  google: ["text", "vision", "search", "image", "audio", "embed"],
  xai: ["text", "vision", "search", "image"],
  deepseek: ["text"],
  zhipu: ["text", "vision"],
  moonshot: ["text", "vision"],
  mistral: ["text", "vision", "embed"],
  // A gateway is whatever is behind it; claiming more would be guessing on the
  // user's behalf about models we have never seen.
  openrouter: ["text", "vision"],
  "self-hosted": ["text"],
};

/**
 * What one model can do.
 *
 * Vision comes from the model, because it genuinely varies within a vendor —
 * DeepSeek's text models cannot see and that is the reason the frontier tier
 * refuses them. Everything else comes from the vendor.
 */
export function capabilitiesOf(model: {
  readonly provider: string;
  readonly supportsVision: boolean;
  readonly capabilities?: readonly ModelCapability[];
}): ReadonlySet<ModelCapability> {
  if (model.capabilities) return new Set(model.capabilities);

  const fromVendor = VENDOR_CAPABILITIES[model.provider] ?? ["text"];
  const set = new Set<ModelCapability>(fromVendor);

  if (model.supportsVision) set.add("vision");
  else set.delete("vision");

  return set;
}

/**
 * Which model handles which capability.
 *
 * `default` is the model the user chose and the one that orchestrates. The
 * overrides exist so an install can be complete when no single vendor is: Claude
 * to reason, GPT to draw. Empty overrides is the ordinary case and the one most
 * people should stay on.
 */
export interface Assignment {
  readonly defaultModel: string;
  readonly overrides?: Readonly<Partial<Record<ModelCapability, string>>>;
}

export interface ResolvedCapability {
  readonly capability: ModelCapability;
  /** The model that will handle it, or undefined when nothing can. */
  readonly modelId?: string;
  /** True when it is handled by a model other than the default. */
  readonly delegated: boolean;
}

export interface Lookup {
  /** Returns undefined for a model this install does not know about. */
  (modelId: string): { readonly provider: string; readonly supportsVision: boolean } | undefined;
}

/**
 * Work out who does what.
 *
 * An override is honoured only if that model can actually do the thing — a user
 * who assigns image generation to a model that cannot draw has made a mistake,
 * and silently obeying it produces a failure at the moment of use rather than a
 * correction at the moment of choosing.
 */
export function resolve(assignment: Assignment, lookup: Lookup): readonly ResolvedCapability[] {
  const primary = lookup(assignment.defaultModel);
  const primaryCan = primary ? capabilitiesOf(primary) : new Set<ModelCapability>();

  return modelCapabilitySchema.options.map((capability) => {
    const override = assignment.overrides?.[capability];
    if (override) {
      const model = lookup(override);
      if (model && capabilitiesOf(model).has(capability)) {
        return { capability, modelId: override, delegated: override !== assignment.defaultModel };
      }
    }

    return primaryCan.has(capability)
      ? { capability, modelId: assignment.defaultModel, delegated: false }
      : { capability, delegated: false };
  });
}

/**
 * What to say in settings.
 *
 * The point of the whole file. Someone choosing Claude should be told, before
 * anything fails, that it reads documents and runs code but cannot draw — and
 * that a key from a vendor which draws would add it. An invisible limitation is
 * discovered as a broken task; a visible one is a decision.
 */
export interface CapabilityReport {
  readonly can: readonly ModelCapability[];
  readonly cannot: readonly ModelCapability[];
  readonly delegated: readonly ResolvedCapability[];
  /**
   * Overrides that were set and could not be honoured.
   *
   * Dropping them is right; dropping them *silently* is not, and that is what
   * happened the first time this ran against the real catalog: an override
   * naming `openai/gpt-5` when the catalog holds `openai/gpt-5.6` was ignored,
   * and the report then said image generation was unavailable — technically
   * true, and useless to somebody looking straight at the key they just added.
   */
  readonly ignored: readonly {
    readonly capability: ModelCapability;
    readonly modelId: string;
    readonly reason: "unknown-model" | "cannot-do-it";
  }[];
  /** Vendors that would fill the gaps, most useful first. */
  readonly wouldFix: readonly string[];
}

export function report(
  assignment: Assignment,
  lookup: Lookup,
  available: ReadonlySet<string> = new Set()
): CapabilityReport {
  const resolved = resolve(assignment, lookup);
  const missing = resolved.filter((entry) => !entry.modelId).map((entry) => entry.capability);

  const ignored: {
    capability: ModelCapability;
    modelId: string;
    reason: "unknown-model" | "cannot-do-it";
  }[] = [];
  for (const [capability, modelId] of Object.entries(assignment.overrides ?? {})) {
    if (!modelId) continue;
    const model = lookup(modelId);
    if (!model) {
      ignored.push({
        capability: capability as ModelCapability,
        modelId,
        reason: "unknown-model",
      });
    } else if (!capabilitiesOf(model).has(capability as ModelCapability)) {
      ignored.push({
        capability: capability as ModelCapability,
        modelId,
        reason: "cannot-do-it",
      });
    }
  }

  /**
   * A vendor is worth suggesting only if it covers something missing, and they
   * are ranked by how much of the gap they close — offering four vendors that
   * each add one thing is a worse answer than one that adds three.
   */
  const wouldFix = Object.entries(VENDOR_CAPABILITIES)
    .filter(([vendor]) => !available.has(vendor) && vendor !== "self-hosted")
    .map(([vendor, capabilities]) => ({
      vendor,
      covers: missing.filter((capability) => capabilities.includes(capability)).length,
    }))
    .filter((entry) => entry.covers > 0)
    .sort((a, b) => b.covers - a.covers)
    .map((entry) => entry.vendor);

  return {
    can: resolved.filter((entry) => entry.modelId).map((entry) => entry.capability),
    cannot: missing,
    delegated: resolved.filter((entry) => entry.delegated),
    ignored,
    wouldFix,
  };
}

/** The report as a sentence, for a chat reply or a settings caption. */
export function describe(result: CapabilityReport): string {
  /**
   * Delegation is shown on the line it belongs to, not in a second list.
   *
   * The first version printed "Generate images" under what it can do and then
   * again under what is delegated, which reads as two facts and is one.
   */
  const via = new Map(result.delegated.map((entry) => [entry.capability, entry.modelId]));

  const lines = [
    "What I can do:",
    ...result.can.map((capability) => {
      const model = via.get(capability);
      return model
        ? `• ${CAPABILITY_LABELS[capability]} — via ${model}`
        : `• ${CAPABILITY_LABELS[capability]}`;
    }),
  ];

  /**
   * Named before the gaps, because a setting that was ignored is a different
   * problem from a capability nobody has: one is fixed by correcting a name,
   * the other by adding a key.
   */
  if (result.ignored.length > 0) {
    lines.push(
      "",
      "Settings I couldn't use:",
      ...result.ignored.map((entry) =>
        entry.reason === "unknown-model"
          ? `• ${CAPABILITY_LABELS[entry.capability]} — I don't know the model "${entry.modelId}"`
          : `• ${CAPABILITY_LABELS[entry.capability]} — ${entry.modelId} can't do that`
      )
    );
  }

  if (result.cannot.length > 0) {
    lines.push(
      "",
      "What I can't:",
      ...result.cannot.map((capability) => `• ${CAPABILITY_LABELS[capability]}`)
    );

    const suggestion = result.wouldFix[0];
    if (suggestion) {
      // Phrased without an article, because "a OpenAI key" is what the obvious
      // version produces and no rule about vowels survives "xAI".
      lines.push("", `Add a key from ${VENDOR_NAMES[suggestion] ?? suggestion} and I could too.`);
    }
  }

  return lines.join("\n");
}
