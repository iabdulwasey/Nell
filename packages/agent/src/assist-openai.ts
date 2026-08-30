/**
 * The assist path, on everything that is not Anthropic.
 *
 * `assist` spoke one vendor's Messages API, so choosing GPT or DeepSeek or a
 * model on your own hardware changed which model *browsed* and left every other
 * kind of task on Claude. The settings screen said the default model did the
 * reasoning, the reading, the searching; the code disagreed, silently, and the
 * only symptoms were a bill and a quality difference nobody could attribute.
 *
 * **The translation is the whole file.** Anthropic's block vocabulary stays as
 * the internal shape — the loop, the file collection, the naming and the
 * did-it-really-make-a-file check are all written in it, and rewriting those to
 * a neutral form would risk four proven behaviours to gain nothing. So this
 * converts on the way out and converts back on the way in, which is what an
 * adapter is for.
 *
 * One format reaches **OpenAI, DeepSeek, Zhipu, Moonshot, OpenRouter and a model
 * on the operator's own hardware**, because they all speak chat completions with
 * function calling. That is the model-agnostic promise made real for the path
 * that does most of the work.
 *
 * **What it deliberately does not claim.** Chat completions has no server-side
 * search and no code sandbox. Search does not need one — it is an HTTP call to a
 * search vendor, and `searchTool` hands it to any model that can call a
 * function. **Running code genuinely does**, and OpenAI's container lives behind
 * a different API, so `code` stays Anthropic-only until that is built rather
 * than being quietly claimed here. A capability that half works is worse than
 * one that is absent, because only the absent one is visible.
 */

import { z } from "zod";
import type { ClientTool, ProducedFile, SuppliedFile } from "./assistant.js";
import { stampToday } from "./provider.js";

/** Where each vendor's OpenAI-compatible endpoint lives. */
export function baseUrlFor(vendor: string, selfHostedBaseUrl?: string): string | undefined {
  switch (vendor) {
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "moonshot":
      return "https://api.moonshot.cn/v1";
    case "zhipu":
      return "https://open.bigmodel.cn/api/paas/v4";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "self-hosted":
      return selfHostedBaseUrl;
    default:
      return undefined;
  }
}

/**
 * Anthropic-shaped conversation → OpenAI-shaped messages.
 *
 * Four shapes to carry across, and the tool ones are where a mistake is
 * expensive: a tool result that does not name the call it answers is dropped by
 * the far end, and the model then loops asking for the same thing again.
 */
export function toOpenAiMessages(
  system: string,
  messages: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const role = message["role"];
    const content = message["content"];

    if (!Array.isArray(content)) {
      out.push({ role, content: String(content ?? "") });
      continue;
    }

    const blocks = content as Record<string, unknown>[];

    /**
     * A turn of tool results becomes one `tool` message per result.
     *
     * Anthropic carries them as blocks inside a single user turn; OpenAI wants
     * them as separate messages, each naming its `tool_call_id`. Collapsing
     * several into one would lose the correspondence and the model would be
     * answered for a question it did not ask.
     */
    const toolResults = blocks.filter((block) => block["type"] === "tool_result");
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: String(result["tool_use_id"] ?? ""),
          content: String(result["content"] ?? ""),
        });
      }
      continue;
    }

    const text = blocks
      .filter((block) => block["type"] === "text")
      .map((block) => String(block["text"] ?? ""))
      .join("\n");

    if (role === "assistant") {
      const calls = blocks
        .filter((block) => block["type"] === "tool_use")
        .map((block) => ({
          id: String(block["id"] ?? ""),
          type: "function",
          function: {
            name: String(block["name"] ?? ""),
            arguments: JSON.stringify(block["input"] ?? {}),
          },
        }));

      out.push({
        role: "assistant",
        // Null rather than "" when there is nothing but tool calls: some
        // endpoints reject an assistant turn with empty content and no calls.
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }

    out.push({ role: role ?? "user", content: text });
  }

  return out;
}

/** Our neutral tool description → OpenAI's function shape. */
export function toOpenAiTools(tools: readonly ClientTool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

const deltaSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number(),
                  id: z.string().nullish(),
                  function: z
                    .object({ name: z.string().nullish(), arguments: z.string().nullish() })
                    .nullish(),
                })
              )
              .nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      })
    )
    .default([]),
});

export interface StreamedTurn {
  readonly content: Record<string, unknown>[];
  readonly stopReason: string | undefined;
}

/**
 * Accumulated deltas → Anthropic-shaped blocks.
 *
 * Arguments arrive as string fragments and are only valid once the stream ends,
 * which is the same hazard the Anthropic path has and the same handling: a call
 * whose JSON never parsed is left without `input`, so the loop refuses it
 * honestly rather than passing a half-object to a tool.
 */
export function foldOpenAiStream(
  events: readonly Record<string, unknown>[],
  onStep?: (note: string) => void
): StreamedTurn {
  let text = "";
  let finish: string | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for (const raw of events) {
    const parsed = deltaSchema.safeParse(raw);
    if (!parsed.success) continue;

    for (const choice of parsed.data.choices) {
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) text += delta.content;

      for (const call of delta.tool_calls ?? []) {
        const existing = calls.get(call.index) ?? { id: "", name: "", args: "" };
        const named = existing.name === "" && call.function?.name;
        const updated = {
          id: call.id ?? existing.id,
          name: call.function?.name ?? existing.name,
          args: existing.args + (call.function?.arguments ?? ""),
        };
        calls.set(call.index, updated);
        if (named) onStep?.(`Using ${updated.name}.`);
      }
    }
  }

  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: "text", text });

  for (const call of [...calls.values()].filter((entry) => entry.name)) {
    const block: Record<string, unknown> = {
      type: "tool_use",
      // Some endpoints omit the id on a single call; the far end still expects
      // one back, so a stable stand-in beats an empty string.
      id: call.id || `call_${call.name}`,
      name: call.name,
    };
    try {
      block["input"] = call.args ? JSON.parse(call.args) : {};
    } catch {
      /* Left undefined: the loop reports a tool call it could not read. */
    }
    content.push(block);
  }

  return {
    content,
    // `length` is this format's way of saying the output ceiling was hit, which
    // downstream already knows how to treat as a failure rather than an answer.
    stopReason: finish === "length" ? "max_tokens" : finish === "tool_calls" ? "tool_use" : finish,
  };
}

/**
 * Files are not carried on this path, and saying so is the honest answer.
 *
 * Chat completions has no container to upload into: the sandbox that would open
 * the file does not exist here. Silently dropping an attachment would produce a
 * model answering confidently about a document it was never shown, which is the
 * failure mode this codebase has spent the most time removing.
 */
export function explainNoFiles(files: readonly SuppliedFile[]): string | undefined {
  if (files.length === 0) return undefined;
  return (
    `The user attached ${String(files.length)} file(s) — ` +
    `${files.map((file) => file.name).join(", ")} — which this model cannot be given, ` +
    `because it has no sandbox to open them in. Say so plainly rather than guessing at ` +
    `the contents.`
  );
}

export type { ProducedFile };
export { stampToday };
