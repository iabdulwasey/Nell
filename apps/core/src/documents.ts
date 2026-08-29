/**
 * Files the user sends, and answering questions about them.
 *
 * Reported directly: a resume went in as one message, "roast my resume as hbs
 * adcom" as the next, and the task failed. Two separate faults, and the second
 * is the more interesting one.
 *
 * The first is that the file never arrived — a document message carries its
 * words in `caption` and has no `text`, so the channel dropped it without a line
 * in the log. The agent then ran the follow-up as a browser task with no resume
 * attached, which looked to the user like it had read the file and been useless.
 *
 * The second is architectural. **Reading a document is not a browser task**, and
 * every request was going through the browser loop because that was the only
 * loop there was. Asking a model to read a PDF and give an opinion needs no
 * page, no clicks and no perception — it is one call. Routing it through a
 * browser is not merely slow, it is a category error, and it is why the answer
 * came back empty rather than wrong.
 *
 * So this is a second way for a message to be answered, chosen when there is a
 * file to answer it about. The rule is deliberately simple and stated plainly
 * below, because a subtle rule about when to use which loop would be a thing
 * nobody could predict.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "@nell/agent";
import type { AccessScope } from "@nell/shared";
import { z } from "zod";

/** What Telegram will hand over, and what is worth keeping. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface StoredFile {
  readonly name: string;
  readonly mimeType: string;
  readonly path: string;
  readonly receivedAt: number;
}

/**
 * Types a model can actually read.
 *
 * Anything else is stored and acknowledged but cannot be reasoned about, and
 * saying so is better than pretending: a user who sends a .docx and gets a
 * confident review of nothing is worse off than one who is told to send a PDF.
 */
export function readableKind(mimeType: string, name: string): "pdf" | "image" | "text" | undefined {
  const lower = name.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("text/") || /\.(txt|md|csv|json|ya?ml|ts|js|py|html?)$/u.test(lower)) {
    return "text";
  }
  return undefined;
}

export interface FetchOptions {
  readonly token: string;
  readonly root: string;
  readonly fetchImpl?: typeof fetch;
}

const filePathSchema = z.object({
  ok: z.boolean(),
  result: z.object({ file_path: z.string(), file_size: z.number().optional() }).optional(),
});

/**
 * Pull a file off Telegram and put it on disk.
 *
 * Two round trips by design of the API: `getFile` resolves an opaque id to a
 * path, and the path is fetched from a different host. Stored per workspace,
 * because a file is one user's and the directory is the only thing keeping it
 * that way.
 */
export async function fetchAttachment(
  scope: AccessScope,
  attachment: { readonly fileId: string; readonly name: string; readonly mimeType: string },
  options: FetchOptions
): Promise<StoredFile | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const located = await fetchImpl(
    `https://api.telegram.org/bot${options.token}/getFile?file_id=${encodeURIComponent(attachment.fileId)}`
  );
  if (!located.ok) return undefined;

  const parsed = filePathSchema.safeParse(await located.json());
  if (!parsed.success || !parsed.data.ok || !parsed.data.result) return undefined;
  if ((parsed.data.result.file_size ?? 0) > MAX_FILE_BYTES) return undefined;

  const download = await fetchImpl(
    `https://api.telegram.org/file/bot${options.token}/${parsed.data.result.file_path}`
  );
  if (!download.ok) return undefined;

  const dir = join(options.root, scope.workspaceId.replaceAll(/[^\w.-]/gu, "_"));
  mkdirSync(dir, { recursive: true });

  // The name is the user's, so it is sanitised rather than trusted: a file
  // called `../../.env` would otherwise be written exactly there.
  const safe = attachment.name.replaceAll(/[^\w.\- ]/gu, "_").slice(0, 120) || "file";
  const path = join(dir, `${String(Date.now())}-${safe}`);
  writeFileSync(path, Buffer.from(await download.arrayBuffer()));

  return { name: attachment.name, mimeType: attachment.mimeType, path, receivedAt: Date.now() };
}

export interface AnswerRequest {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly question: string;
  readonly files: readonly StoredFile[];
  /** Standing facts about the user, so a review can be about their situation. */
  readonly profile?: string;
}

const answerSchema = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "The full answer, written for a chat message. Short paragraphs, bold for names and " +
        "figures, '-' for lists. No tables or headings.",
    },
  },
  required: ["answer"],
};

/**
 * Answer a question about files the user sent.
 *
 * One model call and no browser. The whole point: this was failing not because
 * it was hard but because it was being asked of the wrong machinery.
 */
export async function answerAboutFiles(request: AnswerRequest): Promise<string | undefined> {
  const readable = request.files.filter((file) => readableKind(file.mimeType, file.name));
  if (readable.length === 0) return undefined;

  /**
   * Text files go into the prompt; PDFs and images go as attachments.
   *
   * Splitting them is not fussiness — a model reads a PDF far better as a
   * document block than as whatever text a naive extractor would produce from
   * it, and layout is most of what a resume is.
   */
  const attached: { readonly mediaType: string; readonly data: string }[] = [];
  const inlined: string[] = [];

  for (const file of readable) {
    const kind = readableKind(file.mimeType, file.name);
    const bytes = readFileSync(file.path);

    if (kind === "text") {
      inlined.push(`--- ${file.name} ---\n${bytes.toString("utf8").slice(0, 200_000)}`);
    } else {
      attached.push({
        mediaType: kind === "pdf" ? "application/pdf" : file.mimeType,
        data: bytes.toString("base64"),
      });
    }
  }

  const about = request.profile?.trim()
    ? `About the user — their own words, and reliable:\n${request.profile.trim()}\n\n`
    : "";
  const names = readable.map((file) => file.name).join(", ");
  const content = [
    `${about}${request.question}`,
    "",
    `Attached: ${names}`,
    ...(inlined.length > 0 ? ["", ...inlined] : []),
  ].join("\n");

  const outcome = await request.provider.complete({
    model: request.model,
    system: [
      "You are answering a question about a file the user sent you.",
      "",
      "Be specific and quote the document. A review that could have been written",
      "without reading it is worse than no review — the user knows what a resume",
      "is, and is asking what is wrong with theirs.",
      "",
      "You are writing a chat message, not a document. Short paragraphs, bold for",
      "names and figures, '-' for lists. No tables, no headings, no code fences.",
    ].join("\n"),
    schema: answerSchema,
    messages: [{ role: "user", content, ...(attached.length > 0 ? { documents: attached } : {}) }],
  });

  if (!outcome.ok) return undefined;
  const parsed = z.object({ answer: z.string() }).safeParse(outcome.value);
  return parsed.success ? parsed.data.answer : undefined;
}
