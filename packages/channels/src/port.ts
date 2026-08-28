/**
 * ChannelPort — the contract every messaging surface implements.
 *
 * Channels differ in ways that matter to a personal agent: some have native
 * per-task threads (Telegram forum topics), some are a single flat conversation
 * (SMS), some render markdown and some show it as literal asterisks. Rather than
 * scatter those differences through the agent, each channel declares its
 * capabilities and owns its own renderer.
 */

import { z } from "zod";

export const channelKindSchema = z.enum([
  "web",
  "telegram",
  "whatsapp",
  "imessage",
  "sms",
  "voice",
]);

export type ChannelKind = z.infer<typeof channelKindSchema>;

/**
 * How a channel can separate concurrent tasks.
 * - `native-threads`: real per-task threads (Telegram topics)
 * - `groups`: a separate conversation can be created per task
 * - `single`: one flat thread; tasks must be distinguished by tagging
 */
export type ThreadTopology = "native-threads" | "groups" | "single";

export interface ChannelCapabilities {
  readonly threadTopology: ThreadTopology;
  readonly markdown: boolean;
  readonly richButtons: boolean;
  readonly attachments: boolean;
  /** Max characters per message before the renderer must split. */
  readonly maxMessageLength: number;
  /**
   * Whether the channel permits an unprompted message at any time. WhatsApp,
   * for example, restricts business-initiated messages outside a service window.
   */
  readonly proactiveSends: "always" | "windowed" | "never";
}

/** Normalized inbound message, identical in shape across every channel. */
export interface InboundEnvelope {
  readonly channel: ChannelKind;
  /** Provider message id; used to make ingestion idempotent. */
  readonly providerMessageId: string;
  /** Provider-side conversation identifier. */
  readonly threadRef: string;
  /** Sender identity as the channel knows it (phone, handle, user id). */
  readonly senderRef: string;
  readonly text: string;
  /** Set when the channel reports what this message replies to. */
  readonly replyToProviderMessageId?: string;
  /** Native thread this arrived in, when the channel has them. */
  readonly nativeThreadRef?: string;
  readonly receivedAt: number;
}

/** What the agent wants to say, before channel-specific rendering. */
export interface OutboundMessage {
  readonly text: string;
  /** Task this concerns, so a channel with threads can place it correctly. */
  readonly taskId?: string;
  readonly taskLabel?: string;
  readonly emoji?: string;
  /** Approval prompts may render as buttons where supported. */
  readonly choices?: readonly string[];
}

export interface DeliveryReceipt {
  readonly providerMessageId: string;
  readonly deliveredAt: number;
}

export interface ChannelPort {
  readonly kind: ChannelKind;
  readonly capabilities: ChannelCapabilities;

  /**
   * Verify the request came from the provider and normalize it. Signature
   * verification lives here so an unauthenticated webhook can never reach the
   * agent.
   */
  verifyAndNormalize(request: unknown): Promise<InboundEnvelope>;

  /** Render for this channel and send. */
  send(threadRef: string, message: OutboundMessage): Promise<DeliveryReceipt>;
}

/**
 * Idempotency key for an inbound message.
 *
 * Providers retry webhooks, so the same message arrives more than once. Keying
 * on (channel, providerMessageId) makes ingestion safe to repeat — without it a
 * retry would run the user's request twice.
 */
export function inboundKey(envelope: InboundEnvelope): string {
  return `${envelope.channel}:${envelope.providerMessageId}`;
}
