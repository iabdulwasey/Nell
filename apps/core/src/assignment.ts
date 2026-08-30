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

import { catalogLookup, resolveCapabilities, type Assignment, type ImageVendor } from "@nell/agent";

export { catalogLookup, overridesFromEnv } from "@nell/agent";

/** Vendors that draw *and* whose image endpoint this codebase knows how to call. */
const CAN_DRAW: Readonly<Record<string, ImageVendor>> = {
  openai: "openai",
  google: "google",
};

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
  /**
   * The key check lives inside the resolution now, not beside it.
   *
   * It used to be a second test here — resolve a model, then separately ask
   * whether its vendor had a key — which is how the settings screen and the
   * running behaviour came to disagree. One question, asked once.
   */
  const resolved = resolveCapabilities(
    assignment,
    catalogLookup,
    (vendor) => keyFor(vendor) !== undefined
  );

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
