/**
 * Receiving Telegram messages by long polling.
 *
 * The webhook path in `@nell/channels` is the production shape and needs a
 * public URL. Polling needs nothing, which makes it the honest choice for
 * running this on a laptop — and the agent behaves identically either way,
 * because both produce the same envelope.
 *
 * The thing that actually matters here is not the transport.
 *
 * **Anyone can message a Telegram bot.** The username is public, the bot answers
 * whoever writes to it, and there is no approval step. So a message arriving on
 * this channel is not "the user asking for something" — it is *a stranger's text
 * that happens to be addressed to us*, until the sender is matched against
 * someone this deployment knows. Treating inbound chat as trusted by default
 * would hand the agent's whole capability to whoever finds the bot, and it would
 * look exactly like it was working.
 *
 * So the sender is resolved to a known user or the message is untrusted — which
 * means it can be read and replied to, and cannot cause a task to run.
 */

import {
  CAPABILITIES,
  inboundKey,
  render,
  toPlainText,
  toTelegramHtml,
  type InboundEnvelope,
} from "@nell/channels";
import type { Provenance } from "@nell/shared";
import { readFileSync } from "node:fs";
import { z } from "zod";

const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      date: z.number(),
      text: z.string().optional(),
      /**
       * A shared pin, or a named place from Telegram's "send location".
       *
       * Worth taking as a distinct thing rather than hoping the user types
       * their city: a pin is unambiguous, needs no parsing, and is one tap on
       * the phone they are already holding.
       */
      location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
      venue: z
        .object({
          title: z.string().optional(),
          address: z.string().optional(),
        })
        .optional(),
      /**
       * A file, and the words that came with it.
       *
       * Dropped entirely until now, and silently: the guard below required
       * `text`, which a document message does not have — its words live in
       * `caption`. A resume sent for review was discarded without a line in the
       * log, and the follow-up "roast my resume" then ran as a browser task with
       * no resume attached. The user got a failure and no hint that the file had
       * never arrived, which is the worst version of this: it looked like the
       * agent had read it and been useless.
       */
      caption: z.string().optional(),
      document: z
        .object({
          file_id: z.string(),
          file_name: z.string().optional(),
          mime_type: z.string().optional(),
          file_size: z.number().optional(),
        })
        .optional(),
      /** Photos arrive as a ladder of sizes; the last is the largest. */
      photo: z
        .array(z.object({ file_id: z.string(), file_size: z.number().optional() }))
        .optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
    })
    .optional(),
});

const updatesSchema = z.object({ ok: z.boolean(), result: z.array(updateSchema).default([]) });

export interface InboundMessage {
  readonly envelope: InboundEnvelope;
  /**
   * `user` when the sender is someone this deployment knows; `untrusted`
   * otherwise. Never anything else — a chat message is not a system event.
   */
  readonly provenance: Provenance;
  /** Present only when the sender was recognised. */
  readonly userId?: string;
  readonly idempotencyKey: string;
  /** Present when the user shared a place rather than typing one. */
  readonly sharedLocation?: SharedLocation;
  /** Present when the user sent a file. Not yet downloaded — this is the handle. */
  readonly attachment?: Attachment;
}

export interface Attachment {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface SharedLocation {
  readonly latitude: number;
  readonly longitude: number;
  /** Telegram's own name for the place, when it sent one. */
  readonly label?: string;
}

export interface PollOptions {
  readonly token: string;
  /** Telegram sender id → the user this deployment knows them as. */
  readonly knownSenders: ReadonlyMap<string, string>;
  /** Seconds Telegram holds the request open when there is nothing to say. */
  readonly longPollSeconds?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * One polling pass.
 *
 * Returns the offset to use next, which the caller carries forward. Telegram
 * only forgets an update once a later offset is acknowledged, so a crash between
 * receiving and handling redelivers rather than loses — which is the right way
 * round for a channel where a lost message is a task that never happened.
 */
export async function pollOnce(
  options: PollOptions,
  offset: number
): Promise<{ readonly messages: readonly InboundMessage[]; readonly nextOffset: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.longPollSeconds ?? 25;

  const response = await fetchImpl(`https://api.telegram.org/bot${options.token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offset, timeout, allowed_updates: ["message"] }),
  });

  if (!response.ok) return { messages: [], nextOffset: offset };

  const parsed = updatesSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.ok) return { messages: [], nextOffset: offset };

  const messages: InboundMessage[] = [];
  let nextOffset = offset;

  for (const update of parsed.data.result) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);

    const message = update.message;
    // Text, a pin, or a file. Requiring text drops the two most useful things a
    // person can send from a phone.
    if (!message || (!message.text && !message.location && !message.document && !message.photo)) {
      continue;
    }

    const senderRef = String(message.from?.id ?? message.chat.id);
    const userId = options.knownSenders.get(senderRef);

    const envelope: InboundEnvelope = {
      channel: "telegram",
      // The chat is part of the key because Telegram reuses message ids across
      // chats, so a bare id would let one chat's retry suppress another's.
      providerMessageId: `${String(message.chat.id)}:${String(message.message_id)}`,
      threadRef: String(message.chat.id),
      senderRef,
      text: message.text ?? message.caption ?? placeholderFor(message.venue, message.document),
      receivedAt: message.date * 1000,
    };

    const shared: SharedLocation | undefined = message.location
      ? {
          latitude: message.location.latitude,
          longitude: message.location.longitude,
          ...(message.venue?.title || message.venue?.address
            ? { label: [message.venue.title, message.venue.address].filter(Boolean).join(", ") }
            : {}),
        }
      : undefined;

    const photo = message.photo?.at(-1);
    const attachment: Attachment | undefined = message.document
      ? {
          fileId: message.document.file_id,
          name: message.document.file_name ?? "file",
          mimeType: message.document.mime_type ?? "application/octet-stream",
          bytes: message.document.file_size ?? 0,
        }
      : photo
        ? {
            fileId: photo.file_id,
            name: "photo.jpg",
            mimeType: "image/jpeg",
            bytes: photo.file_size ?? 0,
          }
        : undefined;

    messages.push({
      envelope,
      ...(attachment ? { attachment } : {}),
      ...(shared ? { sharedLocation: shared } : {}),
      // The load-bearing line in this file.
      provenance: userId ? "user" : "untrusted",
      userId,
      idempotencyKey: inboundKey(envelope),
    });
  }

  return { messages, nextOffset };
}

/**
 * What a stranger gets.
 *
 * Answered rather than ignored, because silence from a bot that is plainly
 * online reads as broken and invites retrying. It says what it is and stops
 * there — no capability list, nothing that reads as an invitation to keep going.
 */
/**
 * What a location-only message says it is.
 *
 * The envelope's `text` is what everything downstream reads, and a shared pin
 * has none — leaving it empty would make the message look like nothing arrived.
 */
function placeholderFor(
  venue: { title?: string; address?: string } | undefined,
  document: { file_name?: string } | undefined
): string {
  if (document) return document.file_name ? `Sent ${document.file_name}` : "Sent a file";
  const named = [venue?.title, venue?.address].filter(Boolean).join(", ");
  return named ? `Shared location: ${named}` : "Shared location";
}

export function replyToStranger(): string {
  return (
    "This assistant only works for the person who set it up, so I can't help with that. " +
    "If it's meant to be yours, add your Telegram account on the settings page."
  );
}

export interface SendOptions {
  readonly token: string;
  readonly chatId: string;
  readonly text: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Telegram's limit, minus room for markup.
 *
 * The message is split while it is still markdown, so the HTML it becomes is
 * longer than what was measured — every `&` becomes five characters and every
 * emphasis span gains tags. Splitting at the real 4096 would let a chunk that
 * measured legal arrive illegal, and an oversized message is rejected whole.
 */
const SPLIT_AT = 3500;

/**
 * Send a reply, formatted for Telegram.
 *
 * This used to send the agent's text verbatim, under a comment saying the
 * renderer decided formatting — while no renderer was ever applied. The model
 * writes markdown, because that is the sensible internal format for something
 * that speaks over five different apps, so what actually arrived was
 * `**Top Stories:**` and `1. **NASA...**` with the asterisks showing.
 *
 * Markdown is kept as the internal representation and converted at the edge.
 * That is the only arrangement that works across channels: Telegram takes a
 * small HTML subset, WhatsApp takes its own `*single asterisk*` convention, and
 * iMessage takes no markup at all — so the agent must not be writing for any one
 * of them.
 *
 * **The fallback is the important part.** Telegram rejects an entire message
 * with a 400 if the HTML is malformed anywhere in it, and the symptom is not an
 * error the user sees — it is silence, on a reply they are waiting for. Any
 * failed chunk is retried as flattened plain text, which cannot be malformed.
 * Ugly beats absent.
 */
export async function sendMessage(options: SendOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const chunks = render(
    { text: options.text },
    { ...CAPABILITIES["telegram"]!, maxMessageLength: SPLIT_AT }
  );

  let delivered = true;

  for (const chunk of chunks) {
    const asHtml = await post(fetchImpl, options, toTelegramHtml(chunk), "HTML");
    if (asHtml) continue;

    // Formatting is a nicety; arriving is not.
    delivered = (await post(fetchImpl, options, toPlainText(chunk))) && delivered;
  }

  return delivered;
}

/**
 * Send a file back.
 *
 * Multipart rather than JSON, which is why it does not share `post` — Telegram
 * takes uploads only as `multipart/form-data`, and the caption rides along so a
 * document never arrives without a word about what it is.
 */
export async function sendDocument(options: {
  readonly token: string;
  readonly chatId: string;
  readonly path: string;
  readonly name: string;
  readonly caption?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const form = new FormData();
  form.append("chat_id", options.chatId);
  if (options.caption) form.append("caption", options.caption.slice(0, 1000));
  form.append("document", new Blob([readFileSync(options.path)]), options.name);

  const response = await fetchImpl(`https://api.telegram.org/bot${options.token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  return response.ok;
}

async function post(
  fetchImpl: typeof fetch,
  options: SendOptions,
  text: string,
  parseMode?: "HTML"
): Promise<boolean> {
  const response = await fetchImpl(`https://api.telegram.org/bot${options.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      link_preview_options: { is_disabled: true },
    }),
  });

  return response.ok;
}
