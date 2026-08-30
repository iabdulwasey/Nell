/**
 * Letting the model do the work.
 *
 * The correction to a mistake worth naming, because it shaped a whole layer: I
 * kept asking *what can I build* instead of *what can the model already do*. So
 * a "document" capability was hand-written to render HTML through Chromium, and
 * an image capability would have been hand-written next, and a chart one after
 * that. That road reaches exactly the list of things I thought of, and the
 * standard is "almost everything".
 *
 * The general form is that the model writes and runs code. Then producing a PDF,
 * packaging five images into one, charting a CSV, converting a document, and
 * whatever nobody has thought of are all the same capability — and the model
 * chains them itself rather than being marched through a pipeline somebody
 * enumerated in advance.
 *
 * **It is also one request.** Anthropic's search and code-execution tools run
 * server-side, so a task that searches, computes, and writes a file comes back
 * in a single response with every step inside it. The hand-built pipeline was
 * orchestrating something already orchestrated, less well.
 *
 * **What this cannot do, and why the browser survives.** It has no session, no
 * cookies and no logins. It cannot fill a checkout, clear a captcha, or click
 * anything on a page that is really yours. That is the whole and only remaining
 * job of the browser — which is what a browser was always for.
 *
 * Provider-dependent by nature, and the catalog says so rather than pretending
 * otherwise: a workspace driving with a model whose vendor has no server-side
 * tools keeps answering and browsing and loses this.
 */

import { z } from "zod";
import {
  baseUrlFor,
  explainNoFiles,
  foldOpenAiStream,
  toOpenAiMessages,
  toOpenAiTools,
} from "./assist-openai.js";
import {
  downloadContainerFile,
  foldResponsesOutput,
  toResponsesInput,
  toResponsesTools,
  type ContainerFile,
} from "./assist-responses.js";
import { stampToday } from "./provider.js";

/**
 * `Uint8Array` rather than `Buffer` throughout.
 *
 * Node's `Buffer` is a `Uint8Array` subclass whose backing store may be a
 * `SharedArrayBuffer`, so it is not assignable to `BlobPart` under a strict DOM
 * lib — which the dashboard has, and which turned this into a build failure two
 * packages away. `Uint8Array` works everywhere and `writeFileSync` takes it.
 */
export interface ProducedFile {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/** A file the user sent, to be made available to the model's sandbox. */
export interface SuppliedFile {
  readonly name: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

/**
 * A tool we run ourselves, on behalf of the model.
 *
 * Search and code execution run inside the vendor, which is why they cost one
 * request and no loop. Anything else — another vendor's image model, a
 * calculator, an internal API — has to come back to us, be executed here, and be
 * handed back. That round trip is the whole mechanism behind "one model hands
 * off to another": the specialist is a tool, and the model decides when to reach
 * for it rather than a pipeline deciding in advance.
 */
export interface ClientTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /**
   * Returns what the model should be told, and any files produced. A thrown
   * error becomes a tool error the model can read and work around — a failed
   * tool is information, not the end of the task.
   */
  run(input: unknown): Promise<{ readonly text: string; readonly files?: readonly ProducedFile[] }>;
}

export interface AssistRequest {
  readonly apiKey: string;
  /**
   * `vendor/model`, or a bare model name meaning Anthropic.
   *
   * The vendor half is what decides which wire format is spoken, so it has to
   * survive down to here — it used to be stripped by the caller, which is
   * exactly how this path came to be hardcoded to one vendor while the settings
   * screen described another. A bare name is still accepted so nothing that
   * passed `claude-sonnet-4-5` breaks.
   */
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly files?: readonly SuppliedFile[];
  /** Off by default: each is a real capability with a real bill. */
  readonly search?: boolean;
  readonly code?: boolean;
  /** Tools we execute here, for anything the vendor cannot do itself. */
  readonly tools?: readonly ClientTool[];
  /** Bound, because a model that keeps calling tools would otherwise never stop. */
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Progress, so a long job is visibly working rather than silently hung. */
  readonly onStep?: (note: string) => void;
  /** Technical detail for the operator's log. Never shown to the user. */
  readonly onDiagnostic?: (note: string) => void;
  /**
   * What the user asked for, used to name a file the model did not name.
   *
   * The request is the best description of the document available without
   * asking anybody, and it beats `nell-1.pdf` by a distance.
   */
  readonly nameHint?: string;
  /** Base URL for an OpenAI-compatible endpoint on the operator's own hardware. */
  readonly baseUrl?: string;
}

/**
 * Which wire format this model speaks, and what it can do inside one request.
 *
 * Anthropic is its own shape and carries server-side search and a code sandbox
 * that returns files. Everything else here speaks chat completions with function
 * calling, which has neither — search is supplied as a client tool instead, and
 * running code is genuinely unavailable rather than quietly degraded.
 */
export function assistDialect(
  model: string,
  /**
   * A base URL means an OpenAI-*compatible* endpoint, not OpenAI.
   *
   * Caught by the gate rather than shipped: routing on the vendor alone sent a
   * self-hosted server — an `openai/…` id pointed at somebody's own hardware —
   * to `/v1/responses`, which such a server does not implement. Compatibility is
   * with chat completions; the Responses API is OpenAI's own.
   */
  baseUrl?: string
): {
  readonly vendor: string;
  readonly model: string;
  readonly anthropic: boolean;
  /**
   * OpenAI's Responses API rather than chat completions.
   *
   * A third shape rather than an option on the second, because the code sandbox
   * lives only here — chat completions has no container at all. One vendor, two
   * endpoints, and the choice decides whether `code` works or silently does
   * nothing.
   */
  readonly responses: boolean;
} {
  const slash = model.indexOf("/");
  // A bare name means Anthropic, which is what every existing caller passed.
  if (slash === -1) {
    return { vendor: "anthropic", model, anthropic: true, responses: false };
  }

  const vendor = model.slice(0, slash);
  return {
    vendor,
    model: model.slice(slash + 1),
    anthropic: vendor === "anthropic",
    responses: vendor === "openai" && baseUrl === undefined,
  };
}

export type AssistOutcome =
  | { readonly ok: true; readonly text: string; readonly files: readonly ProducedFile[] }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

const BETAS = ["code-execution-2025-05-22", "files-api-2025-04-14"].join(",");

const blockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.unknown().optional(),
  content: z.unknown().optional(),
});

const responseSchema = z.object({
  content: z.array(blockSchema).default([]),
  stop_reason: z.string().nullish(),
});

const uploadSchema = z.object({ id: z.string() });

/**
 * Put a file where the model's code can open it.
 *
 * Uploaded rather than inlined because inlining hands a model the *contents* to
 * reason about, and this hands its sandbox a *file* to operate on. A resume to
 * be rewritten needs the first; a spreadsheet to be charted needs the second,
 * and a PDF being repackaged needs both.
 */
async function upload(request: AssistRequest, file: SuppliedFile): Promise<string | undefined> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.data)], { type: file.mediaType }), file.name);

  const response = await fetchImpl("https://api.anthropic.com/v1/files", {
    method: "POST",
    headers: {
      "x-api-key": request.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETAS,
    },
    body: form,
  });

  if (!response.ok) return undefined;
  const parsed = uploadSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.id : undefined;
}

/** Fetch something the model made. */
async function download(
  request: AssistRequest,
  fileId: string
): Promise<{ readonly data: Uint8Array; readonly mediaType: string } | undefined> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.anthropic.com/v1/files/${fileId}/content`, {
    headers: {
      "x-api-key": request.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": BETAS,
    },
  });

  if (!response.ok) return undefined;
  return {
    data: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

/**
 * How long nothing may happen before a task is considered stuck.
 *
 * Not a limit on how long the work may take — that number does not exist, and
 * every attempt to guess one has been wrong. A researched document is a longer
 * job than a summary, and a job that is *still going* has earned the time it is
 * using. What is bounded is silence: five minutes with nothing arriving means
 * something is wedged, and the clock is reset by every byte.
 *
 * The same rule the browser loop already runs on, arrived at again because the
 * first version of this picked a bigger number instead of a better question.
 */
export const IDLE_LIMIT_MS = 5 * 60 * 1000;

type StreamOutcome =
  | {
      readonly ok: true;
      readonly content: Record<string, unknown>[];
      readonly stopReason: string | undefined;
      /**
       * Files named by the reply but not carried in it.
       *
       * Only the Responses transport produces these: its container hands back a
       * *citation* — a container id and a file id — and the bytes are a second
       * call. A path that stopped at the citation would name a PDF nobody
       * receives, which is a failure this codebase has already shipped once.
       */
      readonly containerFiles?: readonly ContainerFile[];
    }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/**
 * One streamed request, reassembled into the shape a whole response has.
 *
 * Streaming is not for the typing effect. It is the only way to know a task is
 * alive: the vendor's search and code tools run inside a single HTTP call, so
 * without it a five-minute job is one silent request that either returns or does
 * not, and there is nothing to distinguish work from a hang. With it, every
 * event is proof of life — which is what lets the bound be on *stalling* rather
 * than on duration.
 *
 * The events are folded back into the same block list the non-streaming API
 * returns, so everything downstream is unchanged and none of it knows.
 */
async function streamOnce(
  request: AssistRequest,
  fetchImpl: typeof fetch,
  messages: Record<string, unknown>[],
  tools: Record<string, unknown>[]
): Promise<StreamOutcome> {
  const controller = new AbortController();
  const idleMs = request.timeoutMs ?? IDLE_LIMIT_MS;

  let idle = setTimeout(() => {
    controller.abort();
  }, idleMs);

  /** Every event is proof of life, so every event buys the same time again. */
  const alive = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      controller.abort();
    }, idleMs);
  };

  const dialect = assistDialect(request.model, request.baseUrl);

  let response: Response;
  try {
    response = dialect.responses
      ? await fetchImpl("https://api.openai.com/v1/responses", {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${request.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: dialect.model,
            max_output_tokens: request.maxTokens ?? 32_000,
            // `instructions` rather than a system message: this endpoint keeps
            // them apart, and a system turn in `input` is treated as content.
            instructions: stampToday(request.system, new Date()),
            input: toResponsesInput(messages),
            tools: toResponsesTools(request.tools ?? [], {
              search: request.search === true,
              code: request.code === true,
            }),
            stream: true,
          }),
        })
      : dialect.anthropic
        ? await fetchImpl("https://api.anthropic.com/v1/messages", {
            method: "POST",
            signal: controller.signal,
            headers: {
              "x-api-key": request.apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-beta": BETAS,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: dialect.model,
              /**
               * Generous, because the model writes the document *as code*.
               *
               * 8192 was fine for an answer and nowhere near a designed PDF: the whole
               * text of the document is embedded in the Python that produces it, so a
               * few pages of prose is a few thousand tokens of source before anything
               * has run. It hit the ceiling mid-line, and the task came back looking
               * successful.
               */
              max_tokens: request.maxTokens ?? 32_000,
              /**
               * Stamped here rather than by the caller, for the same reason the
               * providers stamp theirs: `assist` is its own transport and never
               * passes through `ModelProvider`, so it has to carry its own
               * guarantee. A model that does not know the year searches for last
               * year's answer and reports it confidently.
               */
              system: stampToday(request.system, new Date()),
              ...(tools.length > 0 ? { tools } : {}),
              messages,
              stream: true,
            }),
          })
        : await fetchImpl(
            `${request.baseUrl ?? baseUrlFor(dialect.vendor) ?? ""}/chat/completions`,
            {
              method: "POST",
              signal: controller.signal,
              headers: {
                authorization: `Bearer ${request.apiKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: dialect.model,
                max_tokens: request.maxTokens ?? 32_000,
                messages: toOpenAiMessages(stampToday(request.system, new Date()), messages),
                ...(request.tools?.length ? { tools: toOpenAiTools(request.tools) } : {}),
                stream: true,
              }),
            }
          );
  } catch (error) {
    clearTimeout(idle);
    return {
      ok: false,
      reason:
        controller.signal.aborted && error instanceof Error
          ? "nothing happened for five minutes, so I stopped"
          : (error as Error).message,
      retryable: true,
    };
  }

  if (!response.ok || !response.body) {
    clearTimeout(idle);
    const status = response.status;

    /**
     * Read the body. It says what is wrong, and we were throwing it away.
     *
     * A 400 from this vendor carries `{"error":{"message":"..."}}` naming the
     * exact block that was rejected — and the reason reaching the user was
     * "400 from the model", which then became "that didn't work and I couldn't
     * tell why". Both true, both useless, and the information was sitting in
     * the response the whole time. A diagnostic that discards the diagnosis is
     * worse than none, because it looks like one.
     */
    const detail = await response
      .text()
      .then((body) => {
        const parsed = z
          .object({ error: z.object({ message: z.string() }) })
          .safeParse(JSON.parse(body));
        return parsed.success ? parsed.data.error.message : body.slice(0, 300);
      })
      .catch(() => "");

    return {
      ok: false,
      reason: detail
        ? `${String(status)} from the model: ${detail}`
        : `${String(status)} from the model`,
      // 4xx other than rate limiting will fail identically on a retry.
      retryable: status === 429 || status >= 500,
    };
  }

  /**
   * Chat completions is a different stream and folds separately.
   *
   * Kept as its own branch rather than woven into the switch below, because the
   * two formats share only the transport: one sends whole blocks with deltas
   * against them, the other sends fragments against choice indices. Interleaving
   * them would produce a state machine nobody could read.
   */
  /**
   * The Responses stream: read for liveness, and read once more for truth.
   *
   * Every event resets the idle clock, which is what makes a five-minute job
   * distinguishable from a hang. The *content* comes from `response.completed`,
   * which carries the whole output including the annotations that name the
   * files. Reassembling that from deltas would be a second parser of the same
   * data, and the file-bearing path would be the one exercised least.
   */
  if (dialect.responses) {
    let completed: unknown;
    try {
      for await (const event of sse(response.body)) {
        alive();
        const type = event["type"];
        if (type === "response.completed" || type === "response.incomplete") {
          completed = event["response"];
        }
        if (type === "error") {
          clearTimeout(idle);
          return {
            ok: false,
            reason: `the model errored: ${String(event["message"] ?? "")}`,
            retryable: true,
          };
        }
      }
    } catch (error) {
      clearTimeout(idle);
      return {
        ok: false,
        reason: controller.signal.aborted
          ? "nothing happened for five minutes, so I stopped"
          : error instanceof Error
            ? error.message
            : "the stream broke",
        retryable: true,
      };
    }

    clearTimeout(idle);
    if (completed === undefined) {
      return { ok: false, reason: "the model's reply ended without finishing", retryable: true };
    }

    const folded = foldResponsesOutput(completed);
    return {
      ok: true,
      content: folded.content,
      stopReason: folded.stopReason,
      containerFiles: folded.files,
    };
  }

  if (!dialect.anthropic) {
    const events: Record<string, unknown>[] = [];
    try {
      for await (const event of sse(response.body)) {
        alive();
        events.push(event);
      }
    } catch (error) {
      clearTimeout(idle);
      return {
        ok: false,
        reason: controller.signal.aborted
          ? "nothing happened for five minutes, so I stopped"
          : error instanceof Error
            ? error.message
            : "the stream broke",
        retryable: true,
      };
    }

    clearTimeout(idle);
    const folded = foldOpenAiStream(events, request.onStep);
    return { ok: true, content: folded.content, stopReason: folded.stopReason };
  }

  const blocks: Record<string, unknown>[] = [];
  /** Partial JSON for a tool's arguments, which arrive as fragments. */
  const partial = new Map<number, string>();
  let stopReason: string | undefined;

  try {
    for await (const event of sse(response.body)) {
      alive();

      const index = typeof event["index"] === "number" ? event["index"] : -1;

      switch (event["type"]) {
        case "content_block_start": {
          const block = { ...(event["content_block"] as Record<string, unknown>) };
          blocks[index] = block;
          partial.set(index, "");

          // The one place progress is genuinely known, rather than guessed.
          if (block["type"] === "server_tool_use") {
            request.onStep?.(block["name"] === "web_search" ? "Searching." : "Working it out.");
          }
          break;
        }

        case "content_block_delta": {
          const delta = event["delta"] as Record<string, unknown>;
          const block = blocks[index];
          if (!block) break;

          if (delta["type"] === "text_delta") {
            block["text"] = String(block["text"] ?? "") + String(delta["text"] ?? "");
          }
          if (delta["type"] === "input_json_delta") {
            partial.set(index, (partial.get(index) ?? "") + String(delta["partial_json"] ?? ""));
          }
          break;
        }

        case "content_block_stop": {
          const block = blocks[index];
          const json = partial.get(index);
          // Arguments arrive as fragments and are only valid once complete.
          if (block && json) {
            try {
              block["input"] = JSON.parse(json);
            } catch {
              // A tool call whose arguments did not parse is one the caller
              // will refuse; leaving `input` undefined says so honestly.
            }
          }
          break;
        }

        case "message_delta": {
          const delta = event["delta"] as Record<string, unknown> | undefined;
          if (typeof delta?.["stop_reason"] === "string") stopReason = delta["stop_reason"];
          break;
        }

        default:
          break;
      }
    }
  } catch (error) {
    clearTimeout(idle);
    return {
      ok: false,
      reason: controller.signal.aborted
        ? "nothing happened for five minutes, so I stopped"
        : error instanceof Error
          ? error.message
          : "the stream broke",
      retryable: true,
    };
  }

  clearTimeout(idle);
  return { ok: true, content: blocks.filter(Boolean), stopReason };
}

/** Server-sent events, one parsed `data:` payload at a time. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });

    // Events are separated by a blank line; a partial one stays in the buffer.
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf("\n\n");

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // A frame that does not parse is skipped rather than fatal: one bad
          // event should not discard a response that is otherwise arriving.
        }
      }
    }
  }
}

/**
 * Do the job, with whatever tools are turned on.
 *
 * Returns the model's own words plus every file it produced. Failure is a value
 * rather than an exception: a vendor being down is an ordinary Tuesday and
 * should not tear down a task three steps from finishing.
 */
export async function assist(request: AssistRequest): Promise<AssistOutcome> {
  const fetchImpl = request.fetchImpl ?? fetch;

  const dialect = assistDialect(request.model, request.baseUrl);

  if (!dialect.anthropic && !request.baseUrl && !baseUrlFor(dialect.vendor)) {
    return {
      ok: false,
      reason: `I do not know how to talk to ${dialect.vendor}.`,
      retryable: false,
    };
  }

  /**
   * Server-side tools, only where they exist.
   *
   * These are Anthropic's, declared in its own vocabulary, and offering them to
   * an endpoint that speaks chat completions would be sending a tool definition
   * it will reject. On that path the same jobs are done differently: searching
   * arrives as a client tool, and running code is simply unavailable — stated
   * rather than degraded, because a half-working capability is worse than an
   * absent one when only the absent one is visible.
   */
  const tools: Record<string, unknown>[] = [];
  if (dialect.anthropic) {
    /**
     * A server tool wins over a client tool of the same name.
     *
     * Both halves were right and together they were a 400. Searching became a
     * client tool named `web_search` so that *every* vendor could search — and
     * this vendor's own server-side searcher is called `web_search` too. Sending
     * both is `tools: Tool names must be unique.`, which killed every assist
     * task on the Anthropic path within an hour of the client tool shipping.
     *
     * The server one is kept where it exists because it is genuinely better:
     * one request, no round trip, no snippets crossing this process. The client
     * one exists for the vendors that have none.
     *
     * Written as a collision *rule* rather than a special case for this pair,
     * because the next tool a vendor ships server-side will have a name somebody
     * has already used, and the symptom is not one tool misbehaving — it is the
     * entire path returning 400.
     */
    const serverToolNames = new Set<string>();
    if (request.search) {
      tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
      serverToolNames.add("web_search");
    }
    if (request.code) {
      tools.push({ type: "code_execution_20250522", name: "code_execution" });
      serverToolNames.add("code_execution");
    }

    for (const tool of request.tools ?? []) {
      if (serverToolNames.has(tool.name)) continue;
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      });
    }
  }

  /**
   * The user's files, handed to the sandbox.
   *
   * An upload that fails is skipped rather than fatal — the model can still
   * answer from the prompt, and losing one attachment beats losing the task.
   * Off the Anthropic path there is no container to upload into at all, so the
   * model is *told* that files were attached and could not be opened, rather
   * than being left to answer confidently about a document it never saw.
   */
  const uploaded: string[] = [];
  if (dialect.anthropic) {
    for (const file of request.files ?? []) {
      const id = await upload(request, file);
      if (id) uploaded.push(id);
    }
  }

  const unopened = dialect.anthropic ? undefined : explainNoFiles(request.files ?? []);

  const said: string[] = [];
  const preamble: string[] = [];
  const files: ProducedFile[] = [];

  /**
   * The conversation so far.
   *
   * Grows only when a client tool runs: the vendor's own tools resolve inside a
   * single response, so an assist that needs none is still one request. This is
   * the loop that "hand off to another model" actually is.
   */
  const messages: Record<string, unknown>[] = [
    {
      role: "user",
      content: [
        ...uploaded.map((id) => ({ type: "container_upload", file_id: id })),
        { type: "text", text: unopened ? `${request.prompt}\n\n${unopened}` : request.prompt },
      ],
    },
  ];

  for (let turn = 0; turn < (request.maxTurns ?? 6); turn += 1) {
    const streamed = await streamOnce(request, fetchImpl, messages, tools);

    if (!streamed.ok) {
      return { ok: false, reason: streamed.reason, retryable: streamed.retryable };
    }

    const parsed = responseSchema.safeParse({
      content: streamed.content,
      stop_reason: streamed.stopReason,
    });
    if (!parsed.success) return { ok: false, reason: "unexpected reply shape", retryable: true };

    const calls: { id: string; name: string; input: unknown }[] = [];
    const fileIds: string[] = [];

    for (const block of parsed.data.content) {
      /**
       * Adjacent text blocks are one continuous string, not one per paragraph.
       *
       * Pushing each block separately and joining with a blank line was fine
       * while a reply arrived as a single block. With server-side search on, the
       * vendor **splits a sentence around each citation** — so
       *
       *     "There's a Dense Fog Advisory active today, with cloudy skies early"
       *
       * comes back as three text blocks, and the join turned one sentence into
       * three paragraphs, with the comma and the full stop stranded on lines of
       * their own. Reported as "formatting in Telegram isn't perfect"; it was
       * unreadable, and the cause was this line rather than the renderer.
       *
       * The blocks already carry their own spacing. A blank line belongs
       * *between turns* — where the model genuinely stopped to use a tool — and
       * that separation still happens below, because `said` is folded into
       * `preamble` at exactly those points.
       */
      if (block.type === "text" && block.text) {
        const last = said.length - 1;
        if (last >= 0) said[last] = `${said[last]!}${block.text}`;
        else said.push(block.text);
      }

      if (block.type === "server_tool_use") {
        request.onStep?.(block.name === "web_search" ? "Searching." : "Working it out.");
        // A tool ran, so anything said before it was preamble.
        preamble.push(...said);
        said.length = 0;
      }

      if (block.type === "tool_use" && block.id && block.name) {
        calls.push({ id: block.id, name: block.name, input: block.input });
      }

      // Files come back nested inside a tool result, one id per artefact.
      if (block.type === "code_execution_tool_result") {
        const result = block.content as
          | {
              content?: { type?: string; file_id?: string }[];
              return_code?: number;
              stderr?: string;
            }
          | undefined;

        /**
         * Say when the code failed, because otherwise nothing does.
         *
         * A run that errors produces no file and a model that then writes a
         * description of the document it did not make — which reads, to the
         * person waiting, exactly like a working assistant that forgot the
         * attachment. Watched twice: the same request produced a PDF on one
         * attempt and nothing on another, with no way to tell them apart from
         * the outside.
         */
        if (result?.return_code !== undefined && result.return_code !== 0) {
          request.onDiagnostic?.(
            `code exited ${String(result.return_code)}: ${(result.stderr ?? "").slice(0, 300)}`
          );
        }

        for (const item of result?.content ?? []) {
          if (item.type === "code_execution_output" && item.file_id) fileIds.push(item.file_id);
        }
      }
    }

    /**
     * Fetch what the container wrote, before anything reads the reply.
     *
     * The citation names the file; the bytes are a second call. Doing it here
     * rather than at the end means the "it claimed a file and produced none"
     * check below is judging the same reality the user will see.
     */
    for (const cited of streamed.containerFiles ?? []) {
      const fetched = await downloadContainerFile(cited, request.apiKey, fetchImpl);
      if (fetched) files.push(fetched);
      else request.onDiagnostic?.(`could not fetch ${cited.filename} from the container`);
    }

    for (const [index, id] of fileIds.entries()) {
      const fetched = await download(request, id);
      if (!fetched) {
        request.onDiagnostic?.(`could not download file ${id}`);
        continue;
      }

      files.push({
        /**
         * Named from everything it has said, not only from what it said last.
         *
         * The model usually names the file while it is working — before the
         * final turn — so searching only the closing text found nothing and
         * every document arrived as `nell-1.pdf`. A user handed a file with a
         * name they did not choose and cannot recognise has been given a
         * puzzle.
         */
        name: nameFor(
          [...preamble, ...said].join(" "),
          fetched.mediaType,
          files.length + index,
          request.nameHint
        ),
        mediaType: fetched.mediaType,
        data: fetched.data,
      });
    }

    /**
     * Ran out of room to think, which is not the same as finishing.
     *
     * The failure this was found by: asked for a designed PDF, the model
     * searched, began writing the document as Python, and hit the output limit
     * *mid-source* — the reply ended on "Now I'll c". No code ran, no file
     * existed, and it came back `ok: true` carrying a paragraph that reads like
     * an assistant which merely forgot the attachment.
     *
     * A truncated turn that produced nothing is reported as a failure, because
     * the alternative is confidently handing someone a description of a document
     * that was never made.
     */
    if (parsed.data.stop_reason === "max_tokens") {
      request.onDiagnostic?.("hit the output limit mid-answer");
      if (files.length === 0) {
        return {
          ok: false,
          reason: "ran out of room while working — the answer was cut off before anything finished",
          retryable: true,
        };
      }
      break;
    }

    // Nothing for us to run, so the model is finished.
    if (calls.length === 0) break;

    /**
     * Run what it asked for, and hand every result back in one turn.
     *
     * A failing tool becomes a tool error rather than an exception: the model
     * can read "that model is out of quota" and say so, or try another way,
     * where a thrown error just ends the task.
     */
    preamble.push(...said);
    said.length = 0;

    /**
     * The blocks as they arrived, not the parsed ones.
     *
     * `responseSchema` exists to *read* a reply — is there text, was a tool
     * called — and zod strips every key it was not told about. Sending that
     * back was a real bug and a instructive one: a `web_search_tool_result`
     * block carries `tool_use_id`, the schema does not mention it, so the echoed
     * turn was missing a required field and the vendor refused the next request
     * with `messages.1.content.2.web_search_tool_result.tool_use_id: Field
     * required`.
     *
     * It only ever bit when a *client* tool was called, because that is the
     * only time this conversation takes a second turn — a search-and-answer
     * request never echoes anything and never noticed. Which is why "search the
     * web and draw me something" failed while either half alone worked.
     *
     * The rule worth keeping: **a schema used to read a value must never become
     * the value you send back.** What it does not know, it deletes.
     */
    messages.push({ role: "assistant", content: streamed.content });

    const results: Record<string, unknown>[] = [];
    for (const call of calls) {
      const tool = request.tools?.find((candidate) => candidate.name === call.name);
      request.onStep?.(`Using ${call.name}.`);

      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `No tool named ${call.name} is available.`,
        });
        continue;
      }

      try {
        const outcome = await tool.run(call.input);
        files.push(...(outcome.files ?? []));
        results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.text });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: error instanceof Error ? error.message : "the tool failed",
        });
      }
    }

    messages.push({ role: "user", content: results });
  }

  /**
   * Unless it never spoke afterwards — a model that only narrated is still
   * better than silence, so the preamble is the fallback rather than the
   * default.
   */
  const text = said.join("\n\n").trim() || preamble.join("\n\n").trim();

  /**
   * It said it made a file. Check whether it did.
   *
   * Reported directly: *"got a response saying done, even the pdf name, but
   * never got the pdf."* The model wrote a document, named it, described it, and
   * no artefact came back — the code had written it somewhere the sandbox does
   * not collect, so there was nothing to attach and nothing that knew it.
   *
   * This is the worst of the three ways a document can fail, because it is the
   * only one that produces a confident, complete-looking answer. A truncated
   * reply looks wrong; a failed run can be logged; a reply that names a file it
   * never made reads exactly like an assistant that forgot to press attach.
   *
   * So the claim is checked against the artefacts. Being wrong in the cautious
   * direction costs a sentence; being wrong the other way is a promise nobody
   * kept.
   */
  if (files.length === 0 && CLAIMS_A_FILE.test(text)) {
    request.onDiagnostic?.("claimed a file but produced none");
    return {
      ok: false,
      reason:
        "I wrote the document but it never came back as a file — the code saved it somewhere " +
        "I could not collect. Ask again and I'll write it out properly.",
      retryable: true,
    };
  }

  return { ok: true, text, files };
}

/**
 * Language that promises an attachment.
 *
 * Deliberately narrow: it must catch "I've created report.pdf" and must not
 * catch a discussion *about* PDFs. A false positive turns a good answer into an
 * apology, so it looks for a filename with a document extension, or a plain
 * statement of having made one.
 */
const CLAIMS_A_FILE =
  /\b[\w-]{1,60}\.(pdf|docx?|xlsx?|pptx?|csv|png|jpe?g|zip)\b|\b(created|generated|produced|attached|saved|here is|here's) (the |your |a |an )?(pdf|document|file|report|spreadsheet|deck|image)\b/iu;

/**
 * A filename for something the model made.
 *
 * The API returns an id and a media type, not a name — but the model almost
 * always says what it called the file, so the text is searched for one before
 * falling back. A user receiving `file_01K4H4.bin` has been handed a puzzle.
 */
function nameFor(said: string, mediaType: string, index: number, hint?: string): string {
  const extension =
    {
      "application/pdf": "pdf",
      "image/png": "png",
      "image/jpeg": "jpg",
      "text/csv": "csv",
      "application/json": "json",
      "text/plain": "txt",
      "application/zip": "zip",
    }[mediaType.split(";")[0] ?? ""] ?? "bin";

  // What the model called it, if it said.
  const mentioned = /([\w-]{1,60}\.(pdf|png|jpe?g|csv|xlsx?|docx?|txt|md|json|zip|pptx?))/iu.exec(
    said
  );
  if (mentioned) return mentioned[1] as string;

  /**
   * Otherwise, named after what was asked for.
   *
   * `nell-1.pdf` tells the person who receives it nothing, and a folder of
   * `nell-1`, `nell-2`, `nell-3` is worse than one file with a bad name. The
   * request is the best description of the document available without asking
   * anyone, so a document about Lucknow street food arrives as
   * `lucknow-street-food.pdf`.
   */
  const slug = (hint ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .split("-")
    // Words that describe the asking rather than the thing.
    .filter(
      (word) =>
        word.length > 2 &&
        ![
          "the",
          "and",
          "for",
          "with",
          "make",
          "build",
          "create",
          "generate",
          "please",
          "pdf",
          "file",
          "document",
          "well",
          "perfectly",
          "formatted",
          "designed",
        ].includes(word)
    )
    .slice(0, 5)
    .join("-");

  return slug ? `${slug}.${extension}` : `nell-${String(index + 1)}.${extension}`;
}
