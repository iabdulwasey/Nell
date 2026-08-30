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
  // Server-side `web_search`, `web_fetch` and `code_execution`; no image
  // endpoint of any kind, which is why a Claude-default install is the case the
  // settings screen has to handle well.
  anthropic: ["text", "vision", "search", "code"],
  // The only vendor that covers everything: Responses-API search, the Code
  // Interpreter container, `gpt-image-*`, Realtime audio, and embeddings.
  openai: ["text", "vision", "search", "code", "image", "audio", "embed"],
  // Grounding with Google Search, Gemini Image (Imagen was retired in favour of
  // it in August 2026), TTS and the Live API, `gemini-embedding-2`. No sandbox
  // that returns files, so no `code`.
  google: ["text", "vision", "search", "image", "audio", "embed"],
  // Live search over X, and Grok Imagine for pictures.
  xai: ["text", "vision", "search", "image"],
  /**
   * Text only, and the vendor this design exists for.
   *
   * No sandbox and no search, so "one model does the whole job" barely exists
   * here — which is exactly the install that must be told what it is missing
   * rather than left to discover it. Vision arrived in a 2026 experimental
   * model and is not claimed for the vendor: it comes from the catalog entry's
   * own `supportsVision`, which is where a capability that varies *within* a
   * vendor belongs.
   */
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
  /**
   * A model was chosen and its vendor has no key, so this will not work.
   *
   * Kept apart from "nothing can do it" because the two are fixed differently
   * and by different people: one is *choose a model*, the other is *paste a
   * key*. Telling somebody to pick a model for drawing when they have already
   * picked one and merely never added the key is a note that reads as broken.
   */
  readonly needsKeyFrom?: string;
}

export interface Lookup {
  /** Returns undefined for a model this install does not know about. */
  (modelId: string):
    | {
        readonly provider: string;
        readonly supportsVision: boolean;
        readonly capabilities?: readonly ModelCapability[];
      }
    | undefined;
}

/**
 * `NELL_MODEL_IMAGE=openai/gpt-image-2` and one variable per capability.
 *
 * Named after the capability so that adding one does not mean inventing a
 * naming scheme for it, and read from the schema rather than a second list so
 * a capability added there gains a variable here with nobody remembering to.
 */
export function overridesFromEnv(
  env: Record<string, string | undefined>
): Readonly<Partial<Record<ModelCapability, string>>> {
  const overrides: Partial<Record<ModelCapability, string>> = {};
  for (const capability of modelCapabilitySchema.options) {
    const value = env[`NELL_MODEL_${capability.toUpperCase()}`]?.trim();
    if (value) overrides[capability] = value;
  }
  return overrides;
}

/**
 * Whether this install can pay for that vendor.
 *
 * A function rather than a set because the answer is layered in a hosted
 * deployment — the operator's key serves everyone, a workspace may bring its
 * own, and the more specific one wins. Asking a question keeps that resolution
 * in the one place that knows about workspaces.
 */
export interface HasKey {
  (vendor: string): boolean;
}

/**
 * Work out who does what.
 *
 * An override is honoured only if that model can actually do the thing — a user
 * who assigns image generation to a model that cannot draw has made a mistake,
 * and silently obeying it produces a failure at the moment of use rather than a
 * correction at the moment of choosing.
 *
 * **A capability needs a model *and* a key, and `hasKey` is required for that
 * reason.** It was optional, and defaulted to assuming every key was present:
 * an install holding only an Anthropic key, with Google chosen as its default
 * model, reported that it could generate images, hear speech and embed. Every
 * one of those needed a Google key that did not exist. A settings screen wrong
 * in that direction is worse than none, because it is wrong precisely about the
 * thing the person is about to rely on. Making the parameter optional again
 * would restore the lie for whichever caller forgot it, so it is not optional.
 */
export function resolve(
  assignment: Assignment,
  lookup: Lookup,
  hasKey: HasKey
): readonly ResolvedCapability[] {
  const primary = lookup(assignment.defaultModel);
  const primaryCan = primary ? capabilitiesOf(primary) : new Set<ModelCapability>();

  /** A chosen model, subject to whether its vendor is paid for. */
  const chosen = (
    capability: ModelCapability,
    modelId: string,
    delegated: boolean
  ): ResolvedCapability => {
    const vendor = lookup(modelId)?.provider ?? modelId.split("/")[0] ?? "";
    return hasKey(vendor)
      ? { capability, modelId, delegated }
      : { capability, delegated, needsKeyFrom: vendor };
  };

  return modelCapabilitySchema.options.map((capability) => {
    const override = assignment.overrides?.[capability];
    if (override) {
      const model = lookup(override);
      if (model && capabilitiesOf(model).has(capability)) {
        return chosen(capability, override, override !== assignment.defaultModel);
      }
    }

    return primaryCan.has(capability)
      ? chosen(capability, assignment.defaultModel, false)
      : { capability, delegated: false };
  });
}

/**
 * The operator's choice, and the user's on top of it.
 *
 * Precedence is defined once, here, because it is the whole difference between
 * a self-hosted install and a commercial one and it must not be re-derived at
 * each call site. Self-host has an operator layer and usually no workspace
 * layer, so this returns the operator's answer unchanged; hosted has an admin
 * serving hundreds of tenants, any of whom may have been permitted to choose
 * differently.
 *
 * **Most specific wins, per capability rather than per object.** A workspace
 * that overrides only drawing keeps the operator's choice for everything else —
 * replacing the whole override map would silently discard settings the admin
 * made, which is the failure mode of merging at the wrong depth.
 *
 * Whether a workspace is *allowed* to choose is not decided here. That is
 * policy, it differs by edition and by what the operator sells, and a merge
 * function is the wrong place to enforce it: the caller passes `undefined` when
 * user choice is not permitted, which is a rule that cannot be forgotten
 * halfway down.
 */
export function mergeAssignments(
  operator: Assignment,
  workspace?: Partial<Assignment>
): Assignment {
  return {
    defaultModel: workspace?.defaultModel ?? operator.defaultModel,
    overrides: { ...operator.overrides, ...workspace?.overrides },
  };
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
  /** Nothing available can do it. Fixed by choosing a model. */
  readonly cannot: readonly ModelCapability[];
  /**
   * A model is chosen and its vendor is unpaid. Fixed by pasting a key.
   *
   * The distinction is the difference between a useful note and a confusing
   * one: *"pick a model for image generation"* said to somebody who has already
   * picked one reads as the software being broken.
   */
  readonly needsKey: readonly { readonly capability: ModelCapability; readonly vendor: string }[];
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
  const resolved = resolve(assignment, lookup, (vendor) => available.has(vendor));

  /**
   * Two kinds of gap, kept apart all the way to the screen.
   *
   * *Nothing can do it* is fixed by choosing a model. *A model is chosen and
   * unpaid* is fixed by pasting a key. Collapsing them produces the note that
   * tells somebody to pick an image model when they already have.
   */
  const needsKey = resolved
    .filter((entry) => entry.needsKeyFrom !== undefined)
    .map((entry) => ({ capability: entry.capability, vendor: entry.needsKeyFrom! }));

  const missing = resolved
    .filter((entry) => !entry.modelId && entry.needsKeyFrom === undefined)
    .map((entry) => entry.capability);

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
    needsKey,
    delegated: resolved.filter((entry) => entry.delegated && entry.modelId),
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

  /**
   * The nearly-there section, and the one the user asked for by name.
   *
   * Before the flat "what I can't", because it is the shorter path: the choice
   * is already made and one key finishes it. Grouped by vendor so somebody with
   * three capabilities waiting on one key is asked for one key.
   */
  if (result.needsKey.length > 0) {
    const byVendor = new Map<string, ModelCapability[]>();
    for (const entry of result.needsKey) {
      byVendor.set(entry.vendor, [...(byVendor.get(entry.vendor) ?? []), entry.capability]);
    }

    lines.push("", "Waiting on a key:");
    for (const [vendor, capabilities] of byVendor) {
      const what = capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(", ");
      lines.push(`• ${what} — add your ${VENDOR_NAMES[vendor] ?? vendor} key`);
    }
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
