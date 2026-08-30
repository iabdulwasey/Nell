/**
 * The last vendor-bound capability: running code somewhere other than Anthropic.
 *
 * After the chat-completions transport, one thing was still true of one vendor
 * only. Reasoning and reading are what every model does; searching became a tool
 * we supply, so it works anywhere. **Running code is genuinely different** — a
 * sandbox is not an HTTP call we can make on somebody's behalf, and the two
 * honest routes were OpenAI's own container or one we host. Hosting one is a
 * security decision the architecture defers on purpose, so this is the other.
 *
 * It needs a *third* transport rather than an option on the second, and that is
 * the interesting part. Chat completions has no container at all: the tool lives
 * behind the Responses API, which is a different endpoint with a different
 * request shape, a different event stream and a different way of handing back
 * files. Pretending otherwise would mean a `code` capability that silently did
 * nothing, which is the failure this codebase has spent the most effort
 * removing.
 *
 * **Files come back by citation, not by attachment.** The model writes into a
 * container and the reply *mentions* what it made — `container_file_citation`
 * with a container id and a file id — and fetching the bytes is a second call
 * the caller has to know to make. A transport that stopped at the citation would
 * produce exactly the failure already seen once here: a confident answer naming
 * a PDF that never arrives.
 *
 * **The stream is read for liveness and the final event is read for truth.**
 * Every delta resets the idle clock, which is what makes a five-minute job
 * distinguishable from a hang; but the content is taken from `response.completed`,
 * which carries the whole output including annotations. Reassembling from deltas
 * would be a second parser of the same data, and the one that is harder to get
 * right.
 */

import { z } from "zod";
import type { ClientTool, ProducedFile } from "./assistant.js";

/** A file the model wrote into its container, named but not yet fetched. */
export interface ContainerFile {
  readonly containerId: string;
  readonly fileId: string;
  readonly filename: string;
}

export interface ResponsesTurn {
  /** Anthropic-shaped blocks, so the loop above is unchanged. */
  readonly content: Record<string, unknown>[];
  readonly stopReason: string | undefined;
  readonly files: readonly ContainerFile[];
}

/**
 * Our conversation, in the shape this endpoint wants.
 *
 * Three item shapes carry across, and the tool ones are where a mistake is
 * silent: a result that does not name the call it answers is dropped, and the
 * model asks for the same thing again with nothing in the logs to say why.
 */
export function toResponsesInput(
  messages: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];

  for (const message of messages) {
    const role = message["role"];
    const content = message["content"];
    if (!Array.isArray(content)) {
      input.push({ role, content: [{ type: "input_text", text: String(content ?? "") }] });
      continue;
    }

    const blocks = content as Record<string, unknown>[];

    for (const block of blocks) {
      const type = block["type"];

      if (type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: String(block["tool_use_id"] ?? ""),
          output: String(block["content"] ?? ""),
        });
        continue;
      }

      if (type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: String(block["id"] ?? ""),
          name: String(block["name"] ?? ""),
          arguments: JSON.stringify(block["input"] ?? {}),
        });
        continue;
      }

      if (type === "text" && block["text"]) {
        input.push({
          role: role === "assistant" ? "assistant" : "user",
          content: [
            {
              // The two roles want different content types, and sending the
              // wrong one is rejected rather than ignored.
              type: role === "assistant" ? "output_text" : "input_text",
              text: String(block["text"]),
            },
          ],
        });
      }
    }
  }

  return input;
}

/**
 * The tools, ours and theirs.
 *
 * A function tool is *flat* here — `{type, name, description, parameters}` —
 * where chat completions nests the same fields under `function`. Two formats
 * from one vendor, and using the wrong one is a 400 rather than a warning.
 */
export function toResponsesTools(
  clientTools: readonly ClientTool[],
  options: { readonly search: boolean; readonly code: boolean }
): Record<string, unknown>[] {
  const tools: Record<string, unknown>[] = [];

  if (options.search) tools.push({ type: "web_search" });
  // `auto` lets the model reuse a live container across calls in one response,
  // which is what makes "write the file, then read it back" work at all.
  if (options.code) tools.push({ type: "code_interpreter", container: { type: "auto" } });

  for (const tool of clientTools) {
    tools.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    });
  }

  return tools;
}

const annotationSchema = z.object({
  type: z.string(),
  file_id: z.string().optional(),
  container_id: z.string().optional(),
  filename: z.string().optional(),
});

const outputSchema = z.object({
  output: z
    .array(
      z.object({
        type: z.string(),
        call_id: z.string().optional(),
        name: z.string().optional(),
        arguments: z.string().optional(),
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              annotations: z.array(annotationSchema).optional(),
            })
          )
          .optional(),
      })
    )
    .default([]),
  status: z.string().optional(),
  incomplete_details: z.object({ reason: z.string().optional() }).optional(),
});

/**
 * The finished response, as blocks the rest of the loop already understands.
 *
 * Taken from `response.completed` rather than reassembled from deltas: the final
 * event carries the whole output *including annotations*, and annotations are
 * where the files are. Building it twice would mean the file-bearing path was
 * the one exercised least.
 */
export function foldResponsesOutput(response: unknown): ResponsesTurn {
  const parsed = outputSchema.safeParse(response);
  if (!parsed.success) return { content: [], stopReason: undefined, files: [] };

  const content: Record<string, unknown>[] = [];
  const files: ContainerFile[] = [];

  for (const item of parsed.data.output) {
    if (item.type === "function_call" && item.name) {
      const block: Record<string, unknown> = {
        type: "tool_use",
        id: item.call_id ?? `call_${item.name}`,
        name: item.name,
      };
      try {
        block["input"] = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        // Left undefined, so the loop reports a call it could not read rather
        // than passing a half-parsed object to a tool.
      }
      content.push(block);
      continue;
    }

    for (const part of item.content ?? []) {
      if (part.text) content.push({ type: "text", text: part.text });

      for (const annotation of part.annotations ?? []) {
        if (
          annotation.type === "container_file_citation" &&
          annotation.container_id &&
          annotation.file_id
        ) {
          files.push({
            containerId: annotation.container_id,
            fileId: annotation.file_id,
            filename: annotation.filename ?? annotation.file_id,
          });
        }
      }
    }
  }

  /**
   * A truncated answer is a failure, not an answer.
   *
   * The same rule the Anthropic path learned by shipping the opposite: a reply
   * cut off mid-sentence came back `ok: true` carrying a paragraph that read
   * like an assistant which merely forgot the attachment. `max_output_tokens`
   * is this endpoint's spelling of it.
   */
  const stopReason =
    parsed.data.incomplete_details?.reason === "max_output_tokens"
      ? "max_tokens"
      : content.some((block) => block["type"] === "tool_use")
        ? "tool_use"
        : parsed.data.status;

  return { content, stopReason, files };
}

/**
 * Fetch what the code actually wrote.
 *
 * The second call the citation implies, and the reason a transport that stopped
 * at the citation would produce a reply naming a file nobody receives.
 */
export async function downloadContainerFile(
  file: ContainerFile,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProducedFile | undefined> {
  const response = await fetchImpl(
    `https://api.openai.com/v1/containers/${file.containerId}/files/${file.fileId}/content`,
    { headers: { authorization: `Bearer ${apiKey}` } }
  ).catch(() => undefined);

  if (!response?.ok) return undefined;

  return {
    name: file.filename,
    mediaType:
      response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream",
    data: new Uint8Array(await response.arrayBuffer()),
  };
}
