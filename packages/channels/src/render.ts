/**
 * Per-channel rendering.
 *
 * The agent produces one message; each channel decides how it should look. This
 * exists because a shipped personal agent sent raw markdown to iMessage, where
 * `**bold**` renders as literal asterisks — a small thing that makes an
 * assistant feel broken.
 *
 * Rendering also handles task tagging (so a flat thread stays legible when
 * several jobs are running) and length-aware splitting.
 */

import type { ChannelCapabilities, OutboundMessage } from "./port.js";

/** Strip markdown to clean plain text for channels that cannot render it. */
export function toPlainText(markdown: string): string {
  return (
    markdown
      // Fenced code: keep the contents, drop the fence.
      .replaceAll(/```[a-z]*\n?([\s\S]*?)```/gu, "$1")
      .replaceAll(/`([^`]+)`/gu, "$1")
      // Links: keep the label, then the bare URL so it stays clickable.
      .replaceAll(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1 ($2)")
      // Emphasis markers.
      .replaceAll(/\*\*([^*]+)\*\*/gu, "$1")
      .replaceAll(/(?<!\*)\*([^*]+)\*(?!\*)/gu, "$1")
      .replaceAll(/__([^_]+)__/gu, "$1")
      // Headings and blockquotes.
      .replaceAll(/^#{1,6}\s+/gmu, "")
      .replaceAll(/^>\s?/gmu, "")
      // Bullets become a character that survives every channel.
      .replaceAll(/^[-*+]\s+/gmu, "• ")
      .replaceAll(/\n{3,}/gu, "\n\n")
      .trim()
  );
}

/**
 * Split a long message on natural boundaries.
 *
 * Providers reject or silently truncate oversized messages, so splitting is not
 * optional. Paragraphs are preferred, then lines, then a hard cut.
 */
export function splitMessage(text: string, maxLength: number): readonly string[] {
  if (text.length <= maxLength) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    const breakAt =
      lastIndexBefore(window, "\n\n") ??
      lastIndexBefore(window, "\n") ??
      lastIndexBefore(window, " ") ??
      maxLength;

    parts.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

function lastIndexBefore(text: string, separator: string): number | undefined {
  const index = text.lastIndexOf(separator);
  // Only use a break point that is not uselessly early.
  return index > text.length * 0.5 ? index : undefined;
}

/**
 * Prefix a message with its task so a flat thread stays readable.
 *
 * Only applied where the channel has no native threads — adding "🍣 Sushi:" to
 * a message already inside a dedicated Sushi thread is noise.
 */
export function tagForTask(message: OutboundMessage, capabilities: ChannelCapabilities): string {
  const needsTag = capabilities.threadTopology === "single" && message.taskLabel !== undefined;
  if (!needsTag) return message.text;
  const emoji = message.emoji ? `${message.emoji} ` : "";
  return `${emoji}${message.taskLabel ?? ""}: ${message.text}`;
}

/** Present choices as text where buttons are unavailable. */
export function renderChoices(message: OutboundMessage, capabilities: ChannelCapabilities): string {
  if (!message.choices || message.choices.length === 0) return "";
  if (capabilities.richButtons) return "";
  return `\n\n${message.choices.map((choice) => `• ${choice}`).join("\n")}`;
}

/**
 * Full render pipeline: tag, flatten markdown if needed, append choices, split.
 * Returns the sequence of messages to send, in order.
 */
export function render(
  message: OutboundMessage,
  capabilities: ChannelCapabilities
): readonly string[] {
  const tagged = tagForTask(message, capabilities);
  const body = capabilities.markdown ? tagged : toPlainText(tagged);
  const withChoices = `${body}${renderChoices(message, capabilities)}`;
  return splitMessage(withChoices, capabilities.maxMessageLength);
}

/** Capability profiles for the channels we target. */
export const CAPABILITIES: Readonly<Record<string, ChannelCapabilities>> = {
  web: {
    threadTopology: "native-threads",
    markdown: true,
    richButtons: true,
    attachments: true,
    maxMessageLength: 100_000,
    proactiveSends: "always",
  },
  telegram: {
    // Forum topics give real per-task threads — the cleanest fix for the
    // crowded-thread problem, and it costs nothing.
    threadTopology: "native-threads",
    markdown: true,
    richButtons: true,
    attachments: true,
    maxMessageLength: 4096,
    proactiveSends: "always",
  },
  whatsapp: {
    threadTopology: "single",
    markdown: false,
    richButtons: true,
    attachments: true,
    maxMessageLength: 4096,
    // Business-initiated messages outside the service window need a template.
    proactiveSends: "windowed",
  },
  imessage: {
    threadTopology: "groups",
    // The bug this module exists to prevent.
    markdown: false,
    richButtons: false,
    attachments: true,
    maxMessageLength: 2000,
    proactiveSends: "always",
  },
  sms: {
    threadTopology: "single",
    markdown: false,
    richButtons: false,
    attachments: false,
    maxMessageLength: 320,
    proactiveSends: "always",
  },
};
