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

export interface AssistRequest {
  readonly apiKey: string;
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly files?: readonly SuppliedFile[];
  /** Off by default: each is a real capability with a real bill. */
  readonly search?: boolean;
  readonly code?: boolean;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Progress, so a long job is visibly working rather than silently hung. */
  readonly onStep?: (note: string) => void;
}

export type AssistOutcome =
  | { readonly ok: true; readonly text: string; readonly files: readonly ProducedFile[] }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

const BETAS = ["code-execution-2025-05-22", "files-api-2025-04-14"].join(",");

const blockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
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
 * Do the job, with whatever tools are turned on.
 *
 * Returns the model's own words plus every file it produced. Failure is a value
 * rather than an exception: a vendor being down is an ordinary Tuesday and
 * should not tear down a task three steps from finishing.
 */
export async function assist(request: AssistRequest): Promise<AssistOutcome> {
  const fetchImpl = request.fetchImpl ?? fetch;

  const tools: Record<string, unknown>[] = [];
  if (request.search) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
  if (request.code) tools.push({ type: "code_execution_20250522", name: "code_execution" });

  /**
   * The user's files, handed to the sandbox.
   *
   * An upload that fails is skipped rather than fatal — the model can still
   * answer from the prompt, and losing one attachment beats losing the task.
   */
  const uploaded: string[] = [];
  for (const file of request.files ?? []) {
    const id = await upload(request, file);
    if (id) uploaded.push(id);
  }

  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(request.timeoutMs ?? 300_000),
      headers: {
        "x-api-key": request.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": BETAS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 8192,
        system: request.system,
        ...(tools.length > 0 ? { tools } : {}),
        messages: [
          {
            role: "user",
            content: [
              ...uploaded.map((id) => ({ type: "container_upload", file_id: id })),
              { type: "text", text: request.prompt },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "request failed",
      retryable: true,
    };
  }

  if (!response.ok) {
    const status = response.status;
    return {
      ok: false,
      reason: `${String(status)} from the model`,
      // 4xx other than rate limiting will fail identically on a retry.
      retryable: status === 429 || status >= 500,
    };
  }

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) return { ok: false, reason: "unexpected reply shape", retryable: true };

  /**
   * Only what it said *after* the work.
   *
   * A model narrates before reaching for a tool — "I'll analyse your resume, let
   * me first extract the content" — and joining every text block hands the user
   * that preamble ahead of the answer. The blocks after the last tool result are
   * the conclusion; everything before them is throat-clearing about work that
   * has since happened.
   */
  const preamble: string[] = [];
  let said: string[] = [];
  const fileIds: string[] = [];

  for (const block of parsed.data.content) {
    if (block.type === "text" && block.text) said.push(block.text);

    if (block.type === "server_tool_use") {
      request.onStep?.(block.name === "web_search" ? "Searching." : "Working it out.");
      // A tool ran, so anything said before it was preamble.
      preamble.push(...said);
      said = [];
    }

    // Files come back nested inside a tool result, one id per artefact.
    if (block.type === "code_execution_tool_result") {
      const inner = (
        block.content as { content?: { type?: string; file_id?: string }[] } | undefined
      )?.content;
      for (const item of inner ?? []) {
        if (item.type === "code_execution_output" && item.file_id) fileIds.push(item.file_id);
      }
    }
  }

  const files: ProducedFile[] = [];
  for (const [index, id] of fileIds.entries()) {
    const fetched = await download(request, id);
    if (fetched) {
      files.push({
        name: nameFor(said.join(" "), fetched.mediaType, index),
        mediaType: fetched.mediaType,
        data: fetched.data,
      });
    }
  }

  /**
   * Unless it never spoke afterwards — a model that only narrated is still
   * better than silence, so the preamble is the fallback rather than the
   * default.
   */
  const text = said.join("\n\n").trim() || preamble.join("\n\n").trim();
  return { ok: true, text, files };
}

/**
 * A filename for something the model made.
 *
 * The API returns an id and a media type, not a name — but the model almost
 * always says what it called the file, so the text is searched for one before
 * falling back. A user receiving `file_01K4H4.bin` has been handed a puzzle.
 */
function nameFor(said: string, mediaType: string, index: number): string {
  const mentioned = /([\w-]{1,60}\.(pdf|png|jpe?g|csv|xlsx?|docx?|txt|md|json|zip|pptx?))/iu.exec(
    said
  );
  if (mentioned) return mentioned[1] as string;

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

  return `nell-${String(index + 1)}.${extension}`;
}
