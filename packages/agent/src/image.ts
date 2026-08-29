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
 * Chosen because the API named it.
 *
 * `gemini-2.5-flash` now 404s for new keys with a message saying to use the
 * current one — a reminder that a model id in source is a fact with a shelf
 * life, and that hard-coding one means reading the error when it expires.
 */
export const DEFAULT_IMAGE_MODEL = "gemini-3-pro-image";

export interface ImageToolOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface GeminiPart {
  readonly text?: string;
  readonly inlineData?: { readonly mimeType: string; readonly data: string };
}

/**
 * A tool the orchestrating model can call to get pictures.
 *
 * The description matters more than it looks: it is the only thing telling the
 * model when this is the right move, and it is read by a model that otherwise
 * has no idea it cannot draw.
 */
export function imageTool(options: ImageToolOptions): ClientTool {
  const model = options.model ?? DEFAULT_IMAGE_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "generate_image",
    description:
      "Generate a picture from a written description. Use this whenever an image, " +
      "illustration, diagram-as-artwork, logo or photo is wanted — you cannot draw " +
      "yourself. Returns the image as a file. Call it once per picture.",
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
         * A 429 whose message says the quota is zero is not a limit that clears
         * — the account was never permitted, and waiting achieves nothing.
         */
        if (response.status === 429 && /limit:\s*0/u.test(body)) {
          return {
            text:
              "Image generation is not enabled on this Google account — the free tier " +
              "allows none at all. Billing has to be switched on for the project before " +
              "any picture can be made. Tell the user that plainly.",
          };
        }

        return {
          text: `The image model refused: ${String(response.status)}. Say so rather than retrying.`,
        };
      }

      const body = (await response.json()) as {
        candidates?: { content?: { parts?: GeminiPart[] } }[];
      };

      const parts = body.candidates?.[0]?.content?.parts ?? [];
      const files: ProducedFile[] = [];
      const notes: string[] = [];

      for (const [index, part] of parts.entries()) {
        if (part.inlineData) {
          const safe = (filename ?? "image").replaceAll(/[^\w.-]/gu, "_").slice(0, 50) || "image";
          files.push({
            name: `${safe}${parts.length > 1 ? `-${String(index + 1)}` : ""}.png`,
            mediaType: part.inlineData.mimeType,
            data: Buffer.from(part.inlineData.data, "base64"),
          });
        } else if (part.text) {
          notes.push(part.text);
        }
      }

      if (files.length === 0) {
        return { text: notes.join(" ") || "The image model returned nothing." };
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
