/**
 * WhatsApp.
 *
 * Two things about this channel are unlike every other one, and both will
 * silently break an agent that treats it as "SMS with better formatting".
 *
 * **The service window.** A business may send freeform messages only within 24
 * hours of the user's last message. Outside that window, a freeform send is
 * *accepted by the API and never delivered* — no error, no bounce, nothing. For
 * a proactive agent this is the failure that matters most: a task finishes at
 * 3am, the agent reports the booking, and the user never learns it happened.
 * Outside the window the only thing that reaches them is a pre-approved
 * template, so the window is modelled here as a first-class thing rather than
 * discovered in production.
 *
 * **Formatting.** WhatsApp uses its own markers — `*bold*`, `_italic_`,
 * `~strike~` — where `**bold**` renders as literal asterisks with the text
 * between them. Sending markdown here produces exactly the "assistant looks
 * broken" bug the renderer module exists to prevent.
 *
 * Webhook authenticity is a signature over the *raw request body*. That is
 * stated in the type rather than left to a caller's discipline, because
 * verifying a re-serialised object is the classic way to build a check that
 * passes on everything including forgeries.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  ChannelCapabilities,
  ChannelPort,
  DeliveryReceipt,
  InboundEnvelope,
  OutboundMessage,
} from "./port.js";
import { splitMessage } from "./render.js";

export const WHATSAPP_MAX_MESSAGE = 4096;

/** How long after a user's message a business may speak freely. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  // No native per-task threads. Tasks are distinguished by tagging, which the
  // renderer handles.
  threadTopology: "single",
  markdown: false,
  richButtons: true,
  attachments: true,
  maxMessageLength: WHATSAPP_MAX_MESSAGE,
  // The reason this whole file is careful.
  proactiveSends: "windowed",
};

const webhookSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                messages: z
                  .array(
                    z.object({
                      id: z.string(),
                      from: z.string(),
                      timestamp: z.string(),
                      type: z.string(),
                      text: z.object({ body: z.string() }).optional(),
                      context: z.object({ id: z.string() }).optional(),
                    })
                  )
                  .optional(),
              }),
            })
          )
          .optional(),
      })
    )
    .optional(),
});

export interface WhatsAppTransport {
  send(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface WhatsAppRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * The body EXACTLY as received, before parsing.
   *
   * Required as a string, not an object, because the signature covers the bytes
   * that arrived. Re-serialising a parsed object changes key order and
   * whitespace, and a check computed over that either rejects everything or —
   * worse, if someone "fixes" it by comparing loosely — accepts everything.
   */
  readonly rawBody: string;
}

export interface WhatsAppOptions {
  readonly transport: WhatsAppTransport;
  /** App secret, for verifying the webhook signature. */
  readonly appSecret: string;
  readonly now?: () => number;
}

export const SIGNATURE_HEADER = "x-hub-signature-256";

/** A template the business has had approved, for reaching outside the window. */
export interface MessageTemplate {
  readonly name: string;
  readonly language: string;
  /** How many `{{n}}` placeholders the approved body contains. */
  readonly parameterCount: number;
}

/**
 * The templates a proactive agent actually needs.
 *
 * Deliberately few and deliberately vague. A template is approved once and
 * cannot be edited on the fly, so it can only ever carry a label and a nudge —
 * the substance arrives when the user replies and the window reopens. Trying to
 * fit a booking confirmation into an approved template ends with either a
 * rejected template or a message that says nothing.
 */
export const TEMPLATES: Readonly<Record<"task_update" | "needs_you", MessageTemplate>> = {
  task_update: { name: "task_update", language: "en", parameterCount: 1 },
  needs_you: { name: "needs_you", language: "en", parameterCount: 1 },
};

export type SendMode =
  | { readonly kind: "freeform" }
  | { readonly kind: "template"; readonly template: MessageTemplate; readonly reason: string };

/**
 * Decide how a message can be sent.
 *
 * Exported because the *decision* is worth testing on its own, and because a
 * caller sometimes needs to know before composing: there is no point writing
 * three paragraphs that will be replaced by a template stub.
 */
export function chooseSendMode(
  lastInboundAt: number | undefined,
  now: number,
  needsUser: boolean
): SendMode {
  if (lastInboundAt !== undefined && now - lastInboundAt < SERVICE_WINDOW_MS) {
    return { kind: "freeform" };
  }

  return {
    kind: "template",
    template: needsUser ? TEMPLATES.needs_you : TEMPLATES.task_update,
    reason:
      lastInboundAt === undefined
        ? "This person has never messaged us, so only an approved template can reach them."
        : "More than 24 hours since their last message, so a freeform send would be accepted and silently never delivered.",
  };
}

/**
 * Convert markdown into WhatsApp's own markers.
 *
 * WhatsApp has formatting, but not markdown's: bold is `*one asterisk*`, italic
 * is `_underscore_`, strikethrough is `~tilde~`, and monospace is a triple
 * backtick run. Markdown's `**bold**` renders as two literal asterisks, the
 * word, and two more — the "assistant looks broken" bug in a different costume.
 *
 * Sequential replacement is not enough here, and the reason is worth stating:
 * converting `**bold**` to `*bold*` produces a string the *italic* rule then
 * matches, turning it into `_bold_`. Ordering does not save you — the output of
 * one rule is valid input to the next. So converted spans are parked behind
 * placeholders and restored at the end, where nothing can re-match them.
 */
export function toWhatsAppFormatting(markdown: string): string {
  const parked: string[] = [];
  const park = (rendered: string): string => {
    parked.push(rendered);
    return `\u0000W${String(parked.length - 1)}\u0000`;
  };

  const output = markdown
    // Code first, so an asterisk inside a code span stays an asterisk.
    .replaceAll(/```[a-z]*\n?([\s\S]*?)```/gu, (_m, body: string) => park(`\`\`\`${body}\`\`\``))
    .replaceAll(/`([^`\n]+)`/gu, (_m, body: string) => park(`\`\`\`${body}\`\`\``))
    // Links: WhatsApp has no anchor syntax, so the label and the bare URL both
    // have to survive or the message loses one of them.
    .replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_m, label: string, href: string) =>
      park(`${label}: ${href}`)
    )
    // Headings before bold: a heading becomes bold, and a bold run must not
    // then be reconsidered as italic.
    .replaceAll(/^#{1,6}\s+(.+)$/gmu, (_m, body: string) => park(`*${body}*`))
    .replaceAll(/\*\*([^*\n]+)\*\*/gu, (_m, body: string) => park(`*${body}*`))
    .replaceAll(/__([^_\n]+)__/gu, (_m, body: string) => park(`*${body}*`))
    .replaceAll(/~~([^~\n]+)~~/gu, (_m, body: string) => park(`~${body}~`))
    .replaceAll(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/gu, (_m, body: string) => park(`_${body}_`))
    .replaceAll(/^[-*+]\s+/gmu, "• ")
    .replaceAll(/^>\s?/gmu, "")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

  return output.replaceAll(
    /\u0000W(\d+)\u0000/gu,
    (_m, index: string) => parked[Number(index)] ?? ""
  );
}

export class WhatsAppChannel implements ChannelPort {
  readonly kind = "whatsapp" as const;
  readonly capabilities = WHATSAPP_CAPABILITIES;

  readonly #transport: WhatsAppTransport;
  readonly #secret: string;
  readonly #now: () => number;
  /** Last inbound message per user, which is what opens the window. */
  readonly #lastInbound = new Map<string, number>();

  constructor(options: WhatsAppOptions) {
    if (!options.appSecret) {
      throw new Error("A WhatsApp app secret is required; refusing to accept unsigned webhooks.");
    }
    this.#transport = options.transport;
    this.#secret = options.appSecret;
    this.#now = options.now ?? (() => Date.now());
  }

  async verifyAndNormalize(request: unknown): Promise<InboundEnvelope> {
    const { headers, rawBody } = request as WhatsAppRequest;
    const presented = headers?.[SIGNATURE_HEADER] ?? headers?.[SIGNATURE_HEADER.toUpperCase()];

    const expected = `sha256=${createHmac("sha256", this.#secret).update(rawBody).digest("hex")}`;
    if (!presented || !constantTimeEquals(presented, expected)) {
      throw new Error("WhatsApp webhook signature did not verify.");
    }

    const parsed = webhookSchema.safeParse(JSON.parse(rawBody));
    const message = parsed.success
      ? parsed.data.entry?.[0]?.changes?.[0]?.value.messages?.[0]
      : undefined;

    if (!message) throw new Error("Unsupported WhatsApp webhook payload.");
    if (message.type !== "text" || !message.text) {
      throw new Error("WhatsApp message carried no text.");
    }

    // Every inbound message reopens the window. Recorded before anything else
    // can fail, because a missed update here means the agent believes it cannot
    // reply to someone who just messaged it.
    const receivedAt = Number(message.timestamp) * 1000;
    this.#lastInbound.set(message.from, receivedAt);

    return {
      channel: "whatsapp",
      providerMessageId: message.id,
      threadRef: message.from,
      senderRef: message.from,
      text: message.text.body,
      replyToProviderMessageId: message.context?.id,
      receivedAt,
    };
  }

  /** Whether a freeform message would actually reach this person right now. */
  canSpeakFreely(threadRef: string): boolean {
    return chooseSendMode(this.#lastInbound.get(threadRef), this.#now(), false).kind === "freeform";
  }

  async send(threadRef: string, message: OutboundMessage): Promise<DeliveryReceipt> {
    const mode = chooseSendMode(
      this.#lastInbound.get(threadRef),
      this.#now(),
      Boolean(message.choices?.length)
    );

    if (mode.kind === "template") {
      // A template carries a label, not the message. The substance waits for the
      // user to reply, which reopens the window.
      const result = await this.#transport.send({
        messaging_product: "whatsapp",
        to: threadRef,
        type: "template",
        template: {
          name: mode.template.name,
          language: { code: mode.template.language },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: message.taskLabel ?? "your task" }],
            },
          ],
        },
      });

      return { providerMessageId: idOf(result) ?? "", deliveredAt: this.#now() };
    }

    const body = toWhatsAppFormatting(taggedText(message));
    const parts = splitMessage(body, WHATSAPP_MAX_MESSAGE);

    let last = "";
    for (const [index, text] of parts.entries()) {
      const payload: Record<string, unknown> = {
        messaging_product: "whatsapp",
        to: threadRef,
        type: "text",
        text: { body: text, preview_url: false },
      };

      // Buttons on the final part only; repeating them would offer the same
      // approval several times over.
      if (message.choices?.length && index === parts.length - 1) {
        payload["type"] = "interactive";
        payload["interactive"] = {
          type: "button",
          body: { text },
          action: {
            buttons: message.choices.slice(0, 3).map((choice, position) => ({
              type: "reply",
              reply: {
                id: `${message.taskId ?? "task"}:${String(position)}`,
                title: choice.slice(0, 20),
              },
            })),
          },
        };
        delete payload["text"];
      }

      const result = await this.#transport.send(payload);
      last = idOf(result) ?? last;
    }

    return { providerMessageId: last, deliveredAt: this.#now() };
  }

  /** For restoring window state on boot; the durable record lives in Postgres. */
  noteInbound(threadRef: string, at: number): void {
    this.#lastInbound.set(threadRef, at);
  }
}

function taggedText(message: OutboundMessage): string {
  if (!message.taskLabel) return message.text;
  const emoji = message.emoji ? `${message.emoji} ` : "";
  return `${emoji}${message.taskLabel}: ${message.text}`;
}

function idOf(result: Record<string, unknown>): string | undefined {
  const messages = result["messages"];
  if (Array.isArray(messages) && messages[0] && typeof messages[0] === "object") {
    const id = (messages[0] as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  const direct = result["id"];
  return typeof direct === "string" ? direct : undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
