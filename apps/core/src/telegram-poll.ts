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

import { inboundKey, type InboundEnvelope } from "@nell/channels";
import type { Provenance } from "@nell/shared";
import { z } from "zod";

const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      date: z.number(),
      text: z.string().optional(),
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
    if (!message?.text) continue;

    const senderRef = String(message.from?.id ?? message.chat.id);
    const userId = options.knownSenders.get(senderRef);

    const envelope: InboundEnvelope = {
      channel: "telegram",
      // The chat is part of the key because Telegram reuses message ids across
      // chats, so a bare id would let one chat's retry suppress another's.
      providerMessageId: `${String(message.chat.id)}:${String(message.message_id)}`,
      threadRef: String(message.chat.id),
      senderRef,
      text: message.text,
      receivedAt: message.date * 1000,
    };

    messages.push({
      envelope,
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

/** Send a reply. Plain text: the renderer decides formatting, not this. */
export async function sendMessage(options: SendOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(`https://api.telegram.org/bot${options.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      text: options.text,
      link_preview_options: { is_disabled: true },
    }),
  });

  return response.ok;
}
