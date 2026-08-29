/**
 * Telegram.
 *
 * The launch channel, chosen for a structural reason rather than convenience:
 * Telegram forum topics are real per-task threads. The single most common
 * complaint about the incumbent is that everything lands in one crowded
 * conversation — three tasks running, and the user cannot tell which reply
 * belongs to which, or scroll back to a job from yesterday. Every other channel
 * we ship needs tagging to fake this. Here it is native, so a task gets its own
 * thread with its own title and its own unread badge.
 *
 * Two things this file is careful about.
 *
 * **Webhook authenticity.** Anyone can POST to a webhook URL. Telegram's own
 * mechanism is a secret token echoed in a header, and it is checked here, in
 * constant time, before a single field of the payload is trusted — an
 * unauthenticated request must never reach the agent, whatever it claims to say.
 *
 * **Inbound is untrusted.** A Telegram message can come from anyone who finds
 * the bot. Normalizing a message is not the same as vouching for it: the
 * envelope records who the channel says sent it, and the dispatcher decides what
 * that identity is worth. This layer never authorizes anything.
 */

import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  ChannelCapabilities,
  ChannelPort,
  DeliveryReceipt,
  InboundEnvelope,
  OutboundMessage,
} from "./port.js";
import { render, toPlainText } from "./render.js";

/**
 * Convert the agent's markdown into the small HTML subset Telegram accepts.
 *
 * Necessary, and easy to get wrong in a way that silently loses messages.
 * Telegram's HTML parser rejects the *entire* message with a 400 if it meets a
 * bare `&`, `<` or `>` — and agent text is full of them, because it quotes page
 * content and carries URLs with query strings. The reply the user is waiting on
 * simply never arrives, and the only symptom is silence.
 *
 * So entities are escaped before any tag is introduced. Doing it the other way
 * round escapes the tags too, which produces a message that is technically valid
 * and visibly wrong.
 */
export function toTelegramHtml(markdown: string): string {
  const code: string[] = [];
  // Code is lifted out first so its contents are never treated as formatting —
  // an asterisk inside a code span is an asterisk.
  const withPlaceholders = markdown
    .replaceAll(/```[a-z]*\n?([\s\S]*?)```/gu, (_match, body: string) => {
      code.push(`<pre>${escapeHtml(body.trim())}</pre>`);
      return `\u0000CODE${String(code.length - 1)}\u0000`;
    })
    .replaceAll(/`([^`\n]+)`/gu, (_match, body: string) => {
      code.push(`<code>${escapeHtml(body)}</code>`);
      return `\u0000CODE${String(code.length - 1)}\u0000`;
    });

  const escaped = escapeHtml(withPlaceholders);

  const formatted = escaped
    // Links before emphasis: a label may contain emphasis markers.
    .replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (match, label: string, href: string) =>
      // Anything that is not plain http(s) is rendered as text. A link is the
      // one place a message can carry a scheme, and a client that honours an
      // unexpected one turns a chat message into a capability.
      /^https?:\/\//iu.test(href) ? `<a href="${href}">${label}</a>` : match
    )
    .replaceAll(/\*\*([^*\n]+)\*\*/gu, "<b>$1</b>")
    .replaceAll(/__([^_\n]+)__/gu, "<b>$1</b>")
    .replaceAll(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/gu, "<i>$1</i>")
    // Telegram has no headings; bold is the closest honest equivalent.
    .replaceAll(/^#{1,6}\s+(.+)$/gmu, "<b>$1</b>")
    .replaceAll(/^[-*+]\s+/gmu, "• ");

  return formatted.replaceAll(/\u0000CODE(\d+)\u0000/gu, (_match, index: string) => {
    return code[Number(index)] ?? "";
  });
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Telegram's own cap. Longer messages are rejected outright, not truncated. */
export const TELEGRAM_MAX_MESSAGE = 4096;

export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  // The reason this channel is first.
  threadTopology: "native-threads",
  markdown: true,
  richButtons: true,
  attachments: true,
  maxMessageLength: TELEGRAM_MAX_MESSAGE,
  proactiveSends: "always",
};

/**
 * The slice of Telegram's update payload we actually use.
 *
 * Deliberately narrow and non-strict: Telegram adds fields continually, and a
 * schema that rejected unknown ones would turn a routine platform change into an
 * outage. What we read, we validate; what we do not read cannot hurt us.
 */
const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      date: z.number(),
      text: z.string().optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
      message_thread_id: z.number().optional(),
      reply_to_message: z.object({ message_id: z.number() }).optional(),
    })
    .optional(),
});

/**
 * How the adapter reaches Telegram. A port rather than a hard-coded fetch so the
 * tests drive the real adapter instead of a reimplementation of it.
 */
export interface TelegramTransport {
  call(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface TelegramRequest {
  /** Header Telegram echoes the configured secret in. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export interface TelegramOptions {
  readonly transport: TelegramTransport;
  /**
   * The secret registered with setWebhook. Required: an adapter that would
   * accept unsigned requests when misconfigured is worse than one that refuses
   * to start, because the failure is invisible until someone finds the URL.
   */
  readonly webhookSecret: string;
  /** Chat the bot posts into, when a task has no thread of its own yet. */
  readonly now?: () => number;
}

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export class TelegramChannel implements ChannelPort {
  readonly kind = "telegram" as const;
  readonly capabilities = TELEGRAM_CAPABILITIES;

  readonly #transport: TelegramTransport;
  readonly #secret: string;
  readonly #now: () => number;
  /** taskId -> forum topic id, so a task keeps its thread across messages. */
  readonly #topics = new Map<string, number>();

  constructor(options: TelegramOptions) {
    if (!options.webhookSecret) {
      throw new Error(
        "A Telegram webhook secret is required; refusing to accept unsigned updates."
      );
    }
    this.#transport = options.transport;
    this.#secret = options.webhookSecret;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Verify the request came from Telegram, then normalize it.
   *
   * Verification happens first and unconditionally. Parsing before checking
   * would mean a forged payload had already influenced control flow by the time
   * anyone asked whether it was real.
   */
  async verifyAndNormalize(request: unknown): Promise<InboundEnvelope> {
    const { headers, body } = request as TelegramRequest;
    const presented = headers?.[SECRET_HEADER] ?? headers?.[SECRET_HEADER.toUpperCase()];

    if (!presented || !constantTimeEquals(presented, this.#secret)) {
      throw new Error("Telegram webhook signature did not verify.");
    }

    const update = updateSchema.safeParse(body);
    if (!update.success || !update.data.message) {
      throw new Error("Unsupported Telegram update.");
    }

    const message = update.data.message;
    if (message.text === undefined) {
      throw new Error("Telegram update carried no text.");
    }

    return {
      channel: "telegram",
      // Telegram reuses message ids across chats, so the chat has to be part of
      // the key or one chat's retry would suppress another chat's message.
      providerMessageId: `${String(message.chat.id)}:${String(message.message_id)}`,
      threadRef: String(message.chat.id),
      senderRef: String(message.from?.id ?? message.chat.id),
      text: message.text,
      replyToProviderMessageId: message.reply_to_message
        ? `${String(message.chat.id)}:${String(message.reply_to_message.message_id)}`
        : undefined,
      nativeThreadRef:
        message.message_thread_id === undefined ? undefined : String(message.message_thread_id),
      // Telegram sends seconds; everything else here is milliseconds.
      receivedAt: message.date * 1000,
    };
  }

  /**
   * Create a forum topic for a task, so its updates get their own thread.
   *
   * Requires the chat to be a forum-enabled supergroup. When it is not, the
   * caller falls back to tagging — the agent stays usable in a plain chat rather
   * than failing because a group setting is off.
   */
  async openTaskThread(chatId: string, taskId: string, title: string): Promise<number | undefined> {
    const existing = this.#topics.get(taskId);
    if (existing !== undefined) return existing;

    try {
      const result = await this.#transport.call("createForumTopic", {
        chat_id: chatId,
        name: title.slice(0, 128),
      });
      const id = (result["message_thread_id"] ??
        (result["result"] as Record<string, unknown> | undefined)?.["message_thread_id"]) as
        | number
        | undefined;
      if (typeof id !== "number") return undefined;
      this.#topics.set(taskId, id);
      return id;
    } catch {
      return undefined;
    }
  }

  /** Forget a task's thread once it is finished. */
  closeTaskThread(taskId: string): void {
    this.#topics.delete(taskId);
  }

  async send(threadRef: string, message: OutboundMessage): Promise<DeliveryReceipt> {
    const parts = render(message, this.capabilities);
    const topicId = message.taskId === undefined ? undefined : this.#topics.get(message.taskId);

    let lastId = "";
    for (const [index, text] of parts.entries()) {
      const payload: Record<string, unknown> = {
        chat_id: threadRef,
        text: toTelegramHtml(text),
        // HTML rather than MarkdownV2: MarkdownV2 requires escaping a long list
        // of characters and rejects the whole message on one mistake. HTML has a
        // much smaller escape surface, and `toTelegramHtml` owns it.
        parse_mode: "HTML",
        // Link previews turn a booking confirmation into a wall of images.
        link_preview_options: { is_disabled: true },
      };
      if (topicId !== undefined) payload["message_thread_id"] = topicId;

      // Buttons go on the last part only; repeating them per chunk would offer
      // the same approval several times over.
      if (message.choices?.length && index === parts.length - 1) {
        payload["reply_markup"] = {
          inline_keyboard: [
            message.choices.map((choice) => ({
              text: choice,
              callback_data: `${message.taskId ?? "task"}:${choice}`.slice(0, 64),
            })),
          ],
        };
      }

      /**
       * Formatting is a nicety; arriving is not.
       *
       * Telegram rejects the *entire* message with a 400 if the HTML is
       * malformed anywhere in it, and the symptom is not an error the user sees
       * — it is silence, on a reply they are waiting for. `toTelegramHtml`
       * escapes carefully, but "carefully" is not "provably", and the cost of
       * being wrong is the whole message.
       *
       * So a rejected send is retried as flattened plain text, which has no
       * markup left to be malformed. Ugly beats absent.
       */
      let result: Record<string, unknown>;
      try {
        result = await this.#transport.call("sendMessage", payload);
      } catch {
        result = await this.#transport.call("sendMessage", {
          ...payload,
          text: toPlainText(text),
          parse_mode: undefined,
        });
      }
      lastId = messageIdOf(result) ?? lastId;
    }

    return { providerMessageId: lastId, deliveredAt: this.#now() };
  }
}

function messageIdOf(result: Record<string, unknown>): string | undefined {
  const direct = result["message_id"];
  if (typeof direct === "number" || typeof direct === "string") return String(direct);

  const nested = (result["result"] as Record<string, unknown> | undefined)?.["message_id"];
  if (typeof nested === "number" || typeof nested === "string") return String(nested);

  return undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
