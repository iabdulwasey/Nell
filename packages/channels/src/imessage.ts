/**
 * iMessage.
 *
 * The channel the incumbent is actually used through, and the one with the least
 * forgiving surface. Everything below is a constraint the platform imposes
 * rather than a preference:
 *
 * **No formatting at all.** iMessage renders `**bold**` as four asterisks and
 * the word between them. This is not a hypothetical — it is a documented,
 * visible bug in a shipped agent, and it is the reason the renderer module
 * exists. Text is flattened here unconditionally.
 *
 * **Short messages.** A wall of text in a chat bubble is unreadable in a way the
 * same text in a web panel is not, so the cap is far below what the transport
 * would technically accept.
 *
 * **Green-bubble fallback.** A message to a number with no iMessage becomes SMS,
 * which brings a different length limit and real regulatory obligations. STOP,
 * START and HELP are not features to schedule — they are legally required, and
 * a STOP that is answered by an agent explaining itself is a violation. They are
 * handled before anything else sees the message.
 *
 * **Delivery is not receipt.** The transport reports handoff to Apple, not
 * arrival on a phone. A task that treats "sent" as "the user knows" will close
 * itself while the person is still unaware.
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
import { splitMessage, toPlainText } from "./render.js";

/** Well under the transport limit. A chat bubble is not a document. */
export const IMESSAGE_MAX_MESSAGE = 1200;

export const IMESSAGE_CAPABILITIES: ChannelCapabilities = {
  // A separate group chat can be created per task, which is how per-task threads
  // are reached here — Telegram's topics do not transfer.
  threadTopology: "groups",
  // The bug this module exists to prevent.
  markdown: false,
  richButtons: false,
  attachments: true,
  maxMessageLength: IMESSAGE_MAX_MESSAGE,
  proactiveSends: "always",
};

const inboundSchema = z.object({
  message_id: z.string(),
  from: z.string(),
  content: z.string().optional(),
  received_at: z.union([z.number(), z.string()]).optional(),
  /** Present when the message arrived in a group rather than one-to-one. */
  group_id: z.string().optional(),
  is_imessage: z.boolean().optional(),
});

export interface IMessageTransport {
  send(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  createGroup?(participants: readonly string[], name: string): Promise<string>;
}

export interface IMessageRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export interface IMessageOptions {
  readonly transport: IMessageTransport;
  readonly webhookSecret: string;
  readonly now?: () => number;
}

export const IMESSAGE_SIGNATURE_HEADER = "x-nell-imessage-secret";

/**
 * Keywords a carrier requires be honoured, on any number that can fall back to
 * SMS. These are law in several jurisdictions, not product decisions.
 */
export type ComplianceKeyword = "stop" | "start" | "help";

const STOP_WORDS = new Set(["stop", "unsubscribe", "cancel", "end", "quit", "stopall"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const HELP_WORDS = new Set(["help", "info"]);

/**
 * Classify a message against the required keywords.
 *
 * Matched on the whole message, trimmed and lowercased, and nothing else. A
 * message that merely contains the word "stop" — "stop by the shop on the way" —
 * is not an opt-out, and treating it as one would silently disconnect someone
 * mid-conversation.
 */
export function complianceKeyword(text: string): ComplianceKeyword | undefined {
  const word = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "");
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return undefined;
}

/**
 * The required replies.
 *
 * Fixed text, and deliberately not routed through the agent. A STOP answered by
 * a model explaining what it was working on is a violation, and it is exactly
 * what a system that treats these as ordinary messages would produce.
 */
export function complianceReply(keyword: ComplianceKeyword): string {
  switch (keyword) {
    case "stop":
      return "You've been unsubscribed and won't get any more messages from Nell. Reply START to turn them back on.";
    case "start":
      return "You're subscribed again. Reply STOP at any time to stop.";
    case "help":
      return "Nell is a personal assistant. Text it what you need. Reply STOP to unsubscribe.";
  }
}

export class IMessageChannel implements ChannelPort {
  readonly kind = "imessage" as const;
  readonly capabilities = IMESSAGE_CAPABILITIES;

  readonly #transport: IMessageTransport;
  readonly #secret: string;
  readonly #now: () => number;
  readonly #optedOut = new Set<string>();
  readonly #groups = new Map<string, string>();

  constructor(options: IMessageOptions) {
    if (!options.webhookSecret) {
      throw new Error(
        "An iMessage webhook secret is required; refusing to accept unsigned events."
      );
    }
    this.#transport = options.transport;
    this.#secret = options.webhookSecret;
    this.#now = options.now ?? (() => Date.now());
  }

  async verifyAndNormalize(request: unknown): Promise<InboundEnvelope> {
    const { headers, body } = request as IMessageRequest;
    const presented =
      headers?.[IMESSAGE_SIGNATURE_HEADER] ?? headers?.[IMESSAGE_SIGNATURE_HEADER.toUpperCase()];

    if (!presented || !constantTimeEquals(presented, this.#secret)) {
      throw new Error("iMessage webhook signature did not verify.");
    }

    const parsed = inboundSchema.safeParse(body);
    if (!parsed.success) throw new Error("Unsupported iMessage payload.");

    const message = parsed.data;
    if (message.content === undefined || message.content.trim() === "") {
      throw new Error("iMessage event carried no text.");
    }

    const receivedAt =
      typeof message.received_at === "number"
        ? message.received_at
        : message.received_at
          ? Date.parse(message.received_at)
          : this.#now();

    return {
      channel: "imessage",
      providerMessageId: message.message_id,
      threadRef: message.group_id ?? message.from,
      senderRef: message.from,
      text: message.content,
      nativeThreadRef: message.group_id,
      receivedAt: Number.isNaN(receivedAt) ? this.#now() : receivedAt,
    };
  }

  /**
   * Handle an opt-out keyword, if this message is one.
   *
   * Returns the reply that must be sent, or undefined when the message is
   * ordinary. Callers run this BEFORE dispatching to the agent — a STOP that
   * reaches a planner has already gone wrong, because a planner might decide to
   * be helpful about it.
   */
  handleCompliance(envelope: InboundEnvelope): string | undefined {
    const keyword = complianceKeyword(envelope.text);
    if (!keyword) return undefined;

    if (keyword === "stop") this.#optedOut.add(envelope.senderRef);
    if (keyword === "start") this.#optedOut.delete(envelope.senderRef);

    return complianceReply(keyword);
  }

  hasOptedOut(ref: string): boolean {
    return this.#optedOut.has(ref);
  }

  /**
   * Open a group chat for a task.
   *
   * The iMessage equivalent of a forum topic, and the only way to get per-task
   * threads on the channel most people will actually use. Falls back to the
   * one-to-one thread when the vendor cannot create groups, because an agent
   * that stops working over a missing nicety is worse than a crowded thread.
   */
  async openTaskThread(
    participants: readonly string[],
    taskId: string,
    name: string
  ): Promise<string | undefined> {
    const existing = this.#groups.get(taskId);
    if (existing) return existing;
    if (!this.#transport.createGroup) return undefined;

    try {
      const id = await this.#transport.createGroup(participants, name.slice(0, 60));
      this.#groups.set(taskId, id);
      return id;
    } catch {
      return undefined;
    }
  }

  closeTaskThread(taskId: string): void {
    this.#groups.delete(taskId);
  }

  async send(threadRef: string, message: OutboundMessage): Promise<DeliveryReceipt> {
    // Silence after an opt-out is the entire point of an opt-out. Enforced here
    // rather than upstream so no caller can forget.
    if (this.#optedOut.has(threadRef)) {
      return { providerMessageId: "", deliveredAt: this.#now() };
    }

    const target = message.taskId ? (this.#groups.get(message.taskId) ?? threadRef) : threadRef;

    // Choices become numbered lines: there are no buttons here, and "tap yes"
    // with nothing to tap is worse than a plain question.
    const choices = message.choices?.length
      ? `\n\n${message.choices.map((choice, index) => `${String(index + 1)}. ${choice}`).join("\n")}`
      : "";

    const flattened = toPlainText(taggedText(message)) + choices;
    const parts = splitMessage(flattened, IMESSAGE_MAX_MESSAGE);

    let last = "";
    for (const text of parts) {
      const result = await this.#transport.send({ to: target, content: text });
      const id = result["message_id"] ?? result["id"];
      if (typeof id === "string") last = id;
    }

    return { providerMessageId: last, deliveredAt: this.#now() };
  }
}

function taggedText(message: OutboundMessage): string {
  // Tagged only outside a task's own group, where it would be noise.
  if (!message.taskLabel || message.taskId) return message.text;
  const emoji = message.emoji ? `${message.emoji} ` : "";
  return `${emoji}${message.taskLabel}: ${message.text}`;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
