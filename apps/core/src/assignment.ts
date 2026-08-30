/**
 * Which model does what — the admin's answer, in one place.
 *
 * The architecture calls for a default model plus per-capability overrides:
 * *"one model for everything is the ordinary case and stays the default. A
 * hosted or advanced install can assign a model per capability — Claude to
 * reason, GPT to draw, something cheap for bulk."* `capabilities.ts` has
 * implemented the resolution rule (`override[capability] ?? default-if-able`),
 * the report, and the settings text since that amendment was written.
 *
 * **Nothing ever produced an assignment for it to resolve.** `/models` was
 * called with `overrides` permanently undefined, so it could only ever describe
 * the default model — and the picture tool was built straight from
 * `GOOGLE_API_KEY`, bypassing the resolver entirely. Ask for a picture on an
 * install with an OpenAI key and Google unbilled, and the answer was that Nell
 * cannot draw, while the settings screen agreed with it. Both halves correct,
 * no edge between them: the shape this project keeps finding.
 *
 * This is the edge. It reads the admin's choice, resolves it through the same
 * function `/models` reports from, and hands back the vendor each capability
 * actually landed on — so what settings claims and what runs cannot disagree,
 * because they are computed from one call.
 *
 * **Environment rather than a database row**, deliberately. This is an operator
 * decision about which accounts get billed, made once at deploy time by whoever
 * holds the keys — and the keys are already here. A per-user version belongs
 * with the BYOK dashboard, where a user is choosing among keys they own.
 */

import {
  modelCapabilitySchema,
  REFERENCE_CATALOG,
  resolveCapabilities,
  type Assignment,
  type ImageVendor,
  type ModelCapability,
} from "@nell/agent";

/**
 * `NELL_MODEL_IMAGE=openai/gpt-image-1` and friends.
 *
 * One variable per capability, named after it, so adding a capability does not
 * mean inventing a naming scheme for it.
 */
export function overridesFromEnv(
  env: NodeJS.ProcessEnv
): Readonly<Partial<Record<ModelCapability, string>>> {
  const overrides: Partial<Record<ModelCapability, string>> = {};
  // Read from the schema rather than a second list, so a capability added there
  // gains a variable here without anyone remembering to add one.
  for (const capability of modelCapabilitySchema.options) {
    const value = env[`NELL_MODEL_${capability.toUpperCase()}`]?.trim();
    if (value) overrides[capability] = value;
  }
  return overrides;
}

/** Vendors that can draw *and* that this file knows how to call. */
const CAN_DRAW: Readonly<Record<string, ImageVendor>> = {
  openai: "openai",
  google: "google",
};

/**
 * The one lookup, used by both what runs and what settings says.
 *
 * Written as two, briefly, and it drifted within a minute of running: with
 * `NELL_MODEL_IMAGE=google` the drawer resolved happily to Google and drew,
 * while `/models` reported *"I don't know the model 'google'"* and listed image
 * generation under what Nell cannot do. A settings screen contradicting the
 * running behaviour is worse than no settings screen — the person reads it,
 * believes it, and stops asking for the thing that would have worked.
 *
 * The permissiveness lives here rather than at one call site precisely so it
 * cannot apply to only one of them.
 */
export function catalogLookup(
  id: string
): { readonly provider: string; readonly supportsVision: boolean } | undefined {
  const known = REFERENCE_CATALOG.find((model) => model.id === id);
  if (known) return { provider: known.provider, supportsVision: known.supportsVision };

  /**
   * A model id the catalog has never heard of can still be meaningful.
   *
   * The catalog lists *chat* models; `gpt-image-1` is not one and never will
   * be, and neither is the bare vendor name an admin is most likely to write.
   * Refusing those would reject exactly the values this setting exists to
   * accept. The vendor prefix is what carries the meaning, so the vendor is
   * what gets checked.
   */
  const vendor = id.split("/")[0] ?? "";
  return vendor in CAN_DRAW ? { provider: vendor, supportsVision: false } : undefined;
}

export interface Drawer {
  readonly vendor: ImageVendor;
  readonly apiKey: string;
  /** The image endpoint's own model id, which is not the chat model's. */
  readonly model?: string;
}

/**
 * Who draws, and on whose account.
 *
 * Two things have to be separated here and it is worth being explicit, because
 * conflating them is what makes model ids rot. The **vendor** is the durable
 * fact — it decides which HTTP shape to speak and which key pays. The **model
 * id** is a detail with a shelf life: `gemini-2.5-flash` already 404s. So an
 * override may name either `openai` or `openai/gpt-image-1`, and only the part
 * before the slash is required to mean anything.
 *
 * Resolution runs through `capabilityResolve` rather than beside it, so the
 * model `/models` names for `image` is the model that draws.
 */
export function drawerFor(
  assignment: Assignment,
  keyFor: (vendor: string) => string | undefined
): Drawer | undefined {
  const resolved = resolveCapabilities(assignment, catalogLookup);
  const modelId = resolved.find((entry) => entry.capability === "image")?.modelId;
  if (!modelId) return undefined;

  const [vendorName, ...rest] = modelId.split("/");
  const vendor = CAN_DRAW[vendorName ?? ""];
  const apiKey = vendor ? keyFor(vendorName ?? "") : undefined;
  if (!vendor || !apiKey) return undefined;

  /**
   * Only an id that is plainly an image model is passed through.
   *
   * `NELL_MODEL_IMAGE=openai/gpt-5.6` resolves — GPT's *vendor* draws — but
   * `gpt-5.6` is not something the images endpoint accepts, and forwarding it
   * would turn a reasonable setting into a 400 at the moment somebody asks for
   * a picture. The vendor's own default is the right answer there.
   */
  const named = rest.join("/");
  const looksLikeAnImageModel = /image|dall|imagen/iu.test(named);

  return {
    vendor,
    apiKey,
    ...(looksLikeAnImageModel ? { model: named } : {}),
  };
}
