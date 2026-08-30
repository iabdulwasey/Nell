/**
 * Drawing, by a model that draws.
 *
 * The first specialist. Anthropic reasons, reads and runs code but cannot make a
 * picture; Google can. Rather than routing a request to one vendor or the other
 * in advance, this is handed to the primary model *as a tool* — so it decides
 * when a picture is wanted, writes the prompt itself, gets the image back, and
 * carries on with it in the same conversation.
 *
 * That is the whole of "one model hands off to another", and it is why it did
 * not need its own mode: a handoff is a tool call, and the model already knows
 * how to make one.
 *
 * **Google's free tier allows zero image requests.** Not a rate limit that
 * clears — the quota is `limit: 0`, and it needs billing enabled on the project.
 * That is surfaced as its own message rather than a generic failure, because
 * "you have hit a limit" and "this account was never allowed to do this" call
 * for completely different responses from whoever reads it.
 */

import type { ClientTool, ProducedFile } from "./assistant.js";

/**
 * Who can draw.
 *
 * `capabilities.ts` has said `image` for OpenAI, Google and xAI since the
 * capability map was written, and **this file spoke only Google's HTTP shape** —
 * so the catalog could report that an OpenAI key draws pictures while nothing in
 * the process could act on it. The same missing-edge shape as the spend gate and
 * the vault: two correct halves, no join.
 *
 * The vendor is chosen by the caller from the keys it actually has, rather than
 * discovered here, because "which of my accounts is this drawn on" is a billing
 * question and quietly picking is how someone finds out from an invoice.
 */
export type ImageVendor = "google" | "openai";

/**
 * Chosen because each API named it.
 *
 * `gemini-2.5-flash` now 404s for new keys with a message saying to use the
 * current one — a reminder that a model id in source is a fact with a shelf
 * life, and that hard-coding one means reading the error when it expires.
 */
export const DEFAULT_IMAGE_MODEL: Readonly<Record<ImageVendor, string>> = {
  google: "gemini-3-pro-image",
  openai: "gpt-image-1",
};

export interface ImageToolOptions {
  readonly apiKey: string;
  /** Defaults to Google, which is where this started. */
  readonly vendor?: ImageVendor;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface GeminiPart {
  readonly text?: string;
  readonly inlineData?: { readonly mimeType: string; readonly data: string };
}

/** What a vendor hands back: pictures, and anything it said about them. */
interface Drawn {
  readonly images: readonly { readonly mediaType: string; readonly base64: string }[];
  readonly notes: readonly string[];
}

/** A vendor refusing, in words aimed at whoever has to fix it. */
interface Refused {
  readonly refusal: string;
}

const isRefusal = (result: Drawn | Refused): result is Refused => "refusal" in result;

async function drawWithGoogle(
  prompt: string,
  options: ImageToolOptions,
  model: string,
  fetchImpl: typeof fetch
): Promise<Drawn | Refused> {
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      headers: { "x-goog-api-key": options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );

  if (!response.ok) {
    const body = (await response.text()).slice(0, 400);

    /**
     * Told apart because the fixes are different.
     *
     * A 429 whose message says the quota is zero is not a limit that clears —
     * the account was never permitted, and waiting achieves nothing.
     */
    if (response.status === 429 && /limit:\s*0/u.test(body)) {
      return {
        refusal:
          "Image generation is not enabled on this Google account — the free tier " +
          "allows none at all. Billing has to be switched on for the project before " +
          "any picture can be made. Tell the user that plainly.",
      };
    }

    return {
      refusal: `The image model refused: ${String(response.status)}. Say so rather than retrying.`,
    };
  }

  const body = (await response.json()) as {
    candidates?: { content?: { parts?: GeminiPart[] } }[];
  };

  const images: { mediaType: string; base64: string }[] = [];
  const notes: string[] = [];
  for (const part of body.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      images.push({ mediaType: part.inlineData.mimeType, base64: part.inlineData.data });
    } else if (part.text) {
      notes.push(part.text);
    }
  }

  return { images, notes };
}

/**
 * OpenAI's images endpoint.
 *
 * `gpt-image-1` always answers with base64 and never a URL, which is what we
 * want anyway — a URL would have to be fetched back, and a picture that expires
 * before anyone looks at it is worse than no picture.
 */
async function drawWithOpenai(
  prompt: string,
  options: ImageToolOptions,
  model: string,
  fetchImpl: typeof fetch
): Promise<Drawn | Refused> {
  const response = await fetchImpl("https://api.openai.com/v1/images/generations", {
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, n: 1 }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 400);

    /**
     * The one refusal worth naming, because it is not a fault.
     *
     * `gpt-image-1` requires a verified organisation, and the message says so.
     * Reported as itself rather than as a generic failure for the same reason
     * Google's zero quota is: "you must do something once" and "try again later"
     * are different instructions to whoever reads the reply.
     */
    if (/verif/iu.test(body)) {
      return {
        refusal:
          "This OpenAI organisation is not verified, which that image model requires. " +
          "Verifying it in the OpenAI dashboard is a one-time step. Tell the user plainly.",
      };
    }

    return {
      refusal: `The image model refused: ${String(response.status)}. Say so rather than retrying.`,
    };
  }

  const body = (await response.json()) as {
    data?: { b64_json?: string; revised_prompt?: string }[];
  };

  const images: { mediaType: string; base64: string }[] = [];
  const notes: string[] = [];
  for (const entry of body.data ?? []) {
    if (entry.b64_json) images.push({ mediaType: "image/png", base64: entry.b64_json });
    if (entry.revised_prompt) notes.push(entry.revised_prompt);
  }

  return { images, notes };
}

/**
 * A tool the orchestrating model can call to get pictures.
 *
 * The description matters more than it looks: it is the only thing telling the
 * model when this is the right move, and it is read by a model that otherwise
 * has no idea it cannot draw.
 *
 * **It said "use this whenever an image is wanted", and that sentence was a
 * bug.** Asked to *"search the web and download an image of a monkey"*, the
 * model went straight here without searching at all — correctly, on the words in
 * front of it. Wanting an image is not the same as wanting one *invented*, and a
 * description that claims the whole territory wins every time, because the
 * alternative tool said only "download a file from a URL" and there was no URL
 * yet. The model was choosing between an exact match and something that looked
 * inapplicable.
 *
 * So this now states its own boundary rather than its capability. The honest
 * line is *new* — a thing that does not exist yet — and a picture of a real
 * monkey is not that. Drawing one when a photograph was asked for is the
 * plausible-substitute failure that a missing capability always produces, except
 * here the capability was present and the signpost pointed away from it.
 */
export function imageTool(options: ImageToolOptions): ClientTool {
  const vendor = options.vendor ?? "google";
  const model = options.model ?? DEFAULT_IMAGE_MODEL[vendor];
  const fetchImpl = options.fetchImpl ?? fetch;
  const draw = vendor === "openai" ? drawWithOpenai : drawWithGoogle;

  return {
    name: "generate_image",
    description:
      "Draw a NEW picture from a written description — an illustration, a logo, " +
      "artwork, something that does not exist yet. You cannot draw yourself, so this " +
      "is the only way to make one. Do NOT use this to obtain a picture of a real " +
      "thing that already exists on the web: search for it and use fetch_url, which " +
      "returns the real photograph rather than an invented one. Returns the image as " +
      "a file. Call it once per picture.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What to draw, described in full. Be specific about subject, style, " +
            "composition and background — this is the only thing the image model sees.",
        },
        filename: {
          type: "string",
          description: "A short name for the file, without an extension.",
        },
      },
      required: ["prompt"],
    },

    async run(input: unknown): Promise<{ text: string; files?: readonly ProducedFile[] }> {
      const { prompt, filename } = (input ?? {}) as { prompt?: string; filename?: string };
      if (!prompt?.trim()) return { text: "No prompt was given, so nothing was drawn." };

      const drawn = await draw(prompt, options, model, fetchImpl);
      if (isRefusal(drawn)) return { text: drawn.refusal };

      const files: ProducedFile[] = drawn.images.map((image, index) => {
        const safe = (filename ?? "image").replaceAll(/[^\w.-]/gu, "_").slice(0, 50) || "image";
        return {
          name: `${safe}${drawn.images.length > 1 ? `-${String(index + 1)}` : ""}.png`,
          mediaType: image.mediaType,
          data: Buffer.from(image.base64, "base64"),
        };
      });

      if (files.length === 0) {
        return { text: drawn.notes.join(" ") || "The image model returned nothing." };
      }

      /**
       * The file is named back to the model, not just returned.
       *
       * It has to be able to refer to the picture in the next turn — to package
       * it into a PDF, or to say what it made — and a tool result it cannot name
       * is a picture it cannot use.
       */
      return {
        text: `Generated ${files.map((file) => file.name).join(", ")}.`,
        files,
      };
    },
  };
}
