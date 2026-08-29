/**
 * Talking to a model.
 *
 * One port, adapters behind it. The point is not abstraction for its own sake —
 * it is that "pick your own model" has to survive contact with the fact that
 * every vendor's API is shaped differently. If the agent knew it was talking to
 * Anthropic, model choice would be a setting that only ever has one value.
 *
 * Two things this port insists on, and both are about what a model is allowed
 * to be in this system:
 *
 * **A model proposes; it never instructs.** What comes back is parsed against
 * the browser DSL and then goes through the policy chokepoint like anything
 * else. A model is a very good guesser about what to click, and that is all the
 * authority it has here — the same authority a suggestion has.
 *
 * **Malformed output is an ordinary event.** Models produce invalid JSON, invent
 * fields, and occasionally answer a different question. None of that should tear
 * down a task: it comes back as a refusal the caller can retry or report, not an
 * exception. A task that dies because a model stuttered is a worse product than
 * one that says "let me try that again".
 */

import { z } from "zod";

export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  /**
   * A screenshot to look at, base64 PNG.
   *
   * The one thing the port was missing, and it was the whole reason computer use
   * sat built and unreachable: the executor already accepts pixel actions and
   * the browser already performs them, but no model could be *shown* anything.
   *
   * Optional, because a provider that cannot see is still a perfectly good
   * provider for the structured path — a workspace driving with a text-only
   * model keeps every other capability and loses only this one.
   */
  readonly screenshot?: string;
  /**
   * Files to reason about — a PDF, an image — as base64 with their media type.
   *
   * Separate from `screenshot`, which is the agent looking at its own browser.
   * These are the user's documents, and the distinction matters at the provider:
   * a screenshot is context the agent produced, a document is content the user
   * supplied, and only one of those is something they can be asked about.
   */
  readonly documents?: readonly { readonly mediaType: string; readonly data: string }[];
}

export interface CompletionRequest {
  /** Catalog id, e.g. `anthropic/claude-opus-5`. Routed by its prefix. */
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  /** JSON Schema the reply must satisfy. Enforced by the caller, not trusted. */
  readonly schema: Record<string, unknown>;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type CompletionOutcome =
  | { readonly ok: true; readonly value: unknown; readonly usage: TokenUsage }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface ModelProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionOutcome>;
}

/** Where a model's key comes from. Never a literal in code. */
export interface ProviderKeys {
  readonly anthropic?: string;
  readonly openai?: string;
  readonly deepseek?: string;
  readonly zhipu?: string;
  readonly moonshot?: string;
  readonly openrouter?: string;
  /** Base URL for an OpenAI-compatible endpoint on the operator's hardware. */
  readonly selfHostedBaseUrl?: string;
}

export function keysFromEnv(env: Record<string, string | undefined>): ProviderKeys {
  return {
    anthropic: env["ANTHROPIC_API_KEY"],
    openai: env["OPENAI_API_KEY"],
    deepseek: env["DEEPSEEK_API_KEY"],
    zhipu: env["ZHIPU_API_KEY"],
    moonshot: env["MOONSHOT_API_KEY"],
    openrouter: env["OPENROUTER_API_KEY"],
    selfHostedBaseUrl: env["SELF_HOSTED_BASE_URL"],
  };
}

/** Default: long enough for a considered answer, short enough that a hung request does not hold a task open. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const TOOL_NAME = "respond";

/**
 * Anthropic.
 *
 * Structured output via a forced tool call rather than by asking for JSON in
 * prose. Asking politely for JSON works most of the time, and "most of the time"
 * over thousands of steps is a steady drip of parse failures that look like the
 * model being stupid.
 */
export function anthropicProvider(apiKey: string, fetchImpl: typeof fetch = fetch): ModelProvider {
  return {
    name: "anthropic",
    async complete(request) {
      const model = stripPrefix(request.model);

      return call(fetchImpl, request, {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model,
          max_tokens: request.maxTokens ?? 2048,
          system: request.system,
          messages: request.messages.map((message) => ({
            role: message.role,
            /**
             * Image first, then the words about it.
             *
             * Anthropic's guidance, and it is not cosmetic: a model given the
             * question before the picture tends to answer from the question.
             */
            content:
              message.screenshot || message.documents?.length
                ? [
                    ...(message.screenshot
                      ? [
                          {
                            type: "image",
                            source: {
                              type: "base64",
                              media_type: "image/png",
                              data: message.screenshot,
                            },
                          },
                        ]
                      : []),
                    // PDFs are a document block, not an image: the model reads
                    // the text and the layout rather than looking at a picture
                    // of a page, and layout is most of what a resume is.
                    ...(message.documents ?? []).map((doc) => ({
                      type: doc.mediaType === "application/pdf" ? "document" : "image",
                      source: { type: "base64", media_type: doc.mediaType, data: doc.data },
                    })),
                    { type: "text", text: message.content },
                  ]
                : message.content,
          })),
          tools: [
            {
              name: TOOL_NAME,
              description: "Reply with the result.",
              input_schema: request.schema,
            },
          ],
          tool_choice: { type: "tool", name: TOOL_NAME },
        },
        extract: (payload) => {
          const parsed = anthropicReplySchema.safeParse(payload);
          if (!parsed.success) return undefined;

          const block = parsed.data.content.find((item) => item.type === "tool_use");
          if (!block?.input) return undefined;

          return {
            value: block.input,
            usage: {
              inputTokens: parsed.data.usage?.input_tokens ?? 0,
              outputTokens: parsed.data.usage?.output_tokens ?? 0,
            },
          };
        },
      });
    },
  };
}

const anthropicReplySchema = z.object({
  content: z.array(
    z.object({ type: z.string(), input: z.record(z.string(), z.unknown()).optional() })
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

/**
 * Anything speaking OpenAI's chat-completions dialect.
 *
 * One adapter covers DeepSeek, Moonshot, Zhipu, OpenRouter, vLLM, Ollama and
 * OpenAI itself, which is most of what model-agnosticism actually costs. The
 * base URL is the only thing that differs.
 */
export function openAiCompatibleProvider(
  name: string,
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): ModelProvider {
  return {
    name,
    async complete(request) {
      return call(fetchImpl, request, {
        url: `${baseUrl.replace(/\/+$/u, "")}/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: {
          model: stripPrefix(request.model),
          max_tokens: request.maxTokens ?? 2048,
          messages: [
            { role: "system", content: request.system },
            ...request.messages.map((message) => ({
              role: message.role,
              // The OpenAI-compatible shape for images, which every gateway that
              // claims compatibility implements.
              content: message.screenshot
                ? [
                    {
                      type: "image_url",
                      image_url: { url: `data:image/png;base64,${message.screenshot}` },
                    },
                    { type: "text", text: message.content },
                  ]
                : message.content,
            })),
          ],
          tools: [
            {
              type: "function",
              function: {
                name: TOOL_NAME,
                description: "Reply with the result.",
                parameters: request.schema,
              },
            },
          ],
          tool_choice: { type: "function", function: { name: TOOL_NAME } },
        },
        extract: (payload) => {
          const parsed = openAiReplySchema.safeParse(payload);
          if (!parsed.success) return undefined;

          const raw = parsed.data.choices[0]?.message?.tool_calls?.[0]?.function?.arguments;
          if (typeof raw !== "string") return undefined;

          try {
            return {
              value: JSON.parse(raw),
              usage: {
                inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
                outputTokens: parsed.data.usage?.completion_tokens ?? 0,
              },
            };
          } catch {
            return undefined;
          }
        },
      });
    },
  };
}

const openAiReplySchema = z.object({
  choices: z.array(
    z.object({
      message: z
        .object({
          tool_calls: z
            .array(z.object({ function: z.object({ arguments: z.string() }) }))
            .optional(),
        })
        .optional(),
    })
  ),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

interface CallSpec {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly extract: (payload: unknown) => { value: unknown; usage: TokenUsage } | undefined;
}

/**
 * The shared request path.
 *
 * Every failure is classified as retryable or not, because the two call for
 * opposite responses: a rate limit should be waited out, and a malformed request
 * should not be sent again unchanged. Retrying an unretryable failure is how a
 * bug becomes a bill.
 */
async function call(
  fetchImpl: typeof fetch,
  request: CompletionRequest,
  spec: CallSpec
): Promise<CompletionOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(spec.url, {
      method: "POST",
      headers: spec.headers,
      body: JSON.stringify(spec.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      return {
        ok: false,
        // 429 and 5xx are the provider having a moment; 4xx is us being wrong.
        retryable: response.status === 429 || response.status >= 500,
        reason: `${spec.url.includes("anthropic") ? "Anthropic" : "The model provider"} returned ${String(response.status)}: ${detail}`,
      };
    }

    const payload: unknown = await response.json();
    const extracted = spec.extract(payload);

    if (!extracted) {
      // A model that answered in the wrong shape may well answer correctly next
      // time, so this is retryable — but it is not an exception either way.
      return { ok: false, retryable: true, reason: "The model replied in an unexpected shape." };
    }

    return { ok: true, value: extracted.value, usage: extracted.usage };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      retryable: true,
      reason: aborted ? "The model did not reply in time." : "Could not reach the model provider.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Catalog ids are `vendor/model`; the vendor half routes, the rest is the model. */
function stripPrefix(catalogId: string): string {
  const slash = catalogId.indexOf("/");
  return slash === -1 ? catalogId : catalogId.slice(slash + 1);
}

export type ProviderProblem =
  | { readonly kind: "no-key"; readonly vendor: string }
  | { readonly kind: "unknown-vendor"; readonly vendor: string };

export type ProviderResolution =
  | { readonly ok: true; readonly provider: ModelProvider }
  | { readonly ok: false; readonly problem: ProviderProblem };

/**
 * Find the provider for a catalog id.
 *
 * Returns a problem rather than throwing, so a deployment missing one key gets a
 * sentence naming which one rather than a stack trace during a task.
 */
export function providerFor(
  catalogId: string,
  keys: ProviderKeys,
  fetchImpl: typeof fetch = fetch
): ProviderResolution {
  const vendor = catalogId.split("/")[0] ?? "";

  const compatible = (base: string, key: string | undefined) =>
    key
      ? ({ ok: true, provider: openAiCompatibleProvider(vendor, base, key, fetchImpl) } as const)
      : ({ ok: false, problem: { kind: "no-key", vendor } } as const);

  switch (vendor) {
    case "anthropic":
      return keys.anthropic
        ? { ok: true, provider: anthropicProvider(keys.anthropic, fetchImpl) }
        : { ok: false, problem: { kind: "no-key", vendor } };
    case "openai":
      return compatible("https://api.openai.com/v1", keys.openai);
    case "deepseek":
      return compatible("https://api.deepseek.com/v1", keys.deepseek);
    case "moonshot":
      return compatible("https://api.moonshot.cn/v1", keys.moonshot);
    case "zhipu":
      return compatible("https://open.bigmodel.cn/api/paas/v4", keys.zhipu);
    case "openrouter":
      return compatible("https://openrouter.ai/api/v1", keys.openrouter);
    case "self-hosted":
      return keys.selfHostedBaseUrl
        ? {
            ok: true,
            // Local endpoints usually ignore the key entirely; sending a
            // placeholder is simpler than making the header conditional.
            provider: openAiCompatibleProvider(
              vendor,
              keys.selfHostedBaseUrl,
              "not-required",
              fetchImpl
            ),
          }
        : { ok: false, problem: { kind: "no-key", vendor } };
    default:
      return { ok: false, problem: { kind: "unknown-vendor", vendor } };
  }
}

export function explainProviderProblem(problem: ProviderProblem): string {
  switch (problem.kind) {
    case "no-key":
      return `No API key is configured for ${problem.vendor}.`;
    case "unknown-vendor":
      return `${problem.vendor} is not a provider I know how to reach.`;
  }
}
