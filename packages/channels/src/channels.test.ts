import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  inboundKey,
  render,
  splitMessage,
  tagForTask,
  toPlainText,
  type InboundEnvelope,
  type OutboundMessage,
} from "./index.js";

describe("markdown flattening", () => {
  // The bug this exists to prevent: a shipped agent sent raw markdown to
  // iMessage, where **bold** shows as literal asterisks.
  it("removes emphasis markers", () => {
    expect(toPlainText("**Booked** the *8pm* table")).toBe("Booked the 8pm table");
    expect(toPlainText("__strong__ text")).toBe("strong text");
  });

  it("keeps link text and the URL, since the URL must stay usable", () => {
    expect(toPlainText("[your receipt](https://example.com/r/1)")).toBe(
      "your receipt (https://example.com/r/1)"
    );
  });

  it("unwraps code without losing the contents", () => {
    expect(toPlainText("Run `pnpm check` now")).toBe("Run pnpm check now");
    expect(toPlainText("```\nconfirmation NZ-4471\n```")).toBe("confirmation NZ-4471");
  });

  it("converts bullets to a character every channel renders", () => {
    expect(toPlainText("- one\n- two")).toBe("• one\n• two");
  });

  it("strips headings and quotes", () => {
    expect(toPlainText("## Summary\n> quoted")).toBe("Summary\nquoted");
  });

  it("leaves plain text untouched", () => {
    expect(toPlainText("Booked Nozomi at 8pm.")).toBe("Booked Nozomi at 8pm.");
  });
});

describe("splitting", () => {
  it("leaves a short message alone", () => {
    expect(splitMessage("short", 100)).toEqual(["short"]);
  });

  // Providers reject or silently truncate oversized messages.
  it("splits an over-length message", () => {
    const parts = splitMessage("x".repeat(250), 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100);
  });

  it("prefers paragraph boundaries", () => {
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}`;
    const parts = splitMessage(text, 80);
    expect(parts[0]).toBe("a".repeat(60));
  });

  it("never loses content", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join("\n");
    const rejoined = splitMessage(text, 60).join("\n");
    expect(rejoined.replaceAll(/\s+/gu, " ")).toBe(text.replaceAll(/\s+/gu, " "));
  });
});

describe("task tagging", () => {
  const message: OutboundMessage = {
    text: "found 3 options",
    taskLabel: "Sushi",
    emoji: "🍣",
  };

  it("tags on a flat single thread so concurrent jobs stay legible", () => {
    expect(tagForTask(message, CAPABILITIES.sms!)).toBe("🍣 Sushi: found 3 options");
  });

  // Adding "Sushi:" inside a thread already dedicated to Sushi is noise.
  it("does not tag where the channel has native threads", () => {
    expect(tagForTask(message, CAPABILITIES.telegram!)).toBe("found 3 options");
  });

  it("does not tag a message with no task", () => {
    expect(tagForTask({ text: "hello" }, CAPABILITIES.sms!)).toBe("hello");
  });
});

describe("full render pipeline", () => {
  it("keeps markdown for channels that render it", () => {
    const [out] = render({ text: "**Booked** it" }, CAPABILITIES.telegram!);
    expect(out).toBe("**Booked** it");
  });

  it("flattens markdown for channels that do not", () => {
    const [out] = render({ text: "**Booked** it" }, CAPABILITIES.imessage!);
    expect(out).toBe("Booked it");
  });

  it("renders choices as text where buttons are unavailable", () => {
    const [out] = render({ text: "Confirm?", choices: ["Yes", "No"] }, CAPABILITIES.imessage!);
    expect(out).toContain("• Yes");
    expect(out).toContain("• No");
  });

  it("omits text choices where buttons exist", () => {
    const [out] = render({ text: "Confirm?", choices: ["Yes", "No"] }, CAPABILITIES.telegram!);
    expect(out).toBe("Confirm?");
  });

  it("respects each channel's length limit", () => {
    const parts = render({ text: "x".repeat(1000) }, CAPABILITIES.sms!);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(CAPABILITIES.sms!.maxMessageLength);
    }
  });

  it("tags and flattens together on a flat plain-text channel", () => {
    const [out] = render(
      { text: "**Booked** it", taskLabel: "Sushi", emoji: "🍣" },
      CAPABILITIES.sms!
    );
    expect(out).toBe("🍣 Sushi: Booked it");
  });
});

describe("channel capability profiles", () => {
  it("gives Telegram native threads, which is the crowded-thread fix", () => {
    expect(CAPABILITIES.telegram?.threadTopology).toBe("native-threads");
  });

  it("marks iMessage and SMS as not rendering markdown", () => {
    expect(CAPABILITIES.imessage?.markdown).toBe(false);
    expect(CAPABILITIES.sms?.markdown).toBe(false);
  });

  it("records that WhatsApp restricts proactive sends", () => {
    expect(CAPABILITIES.whatsapp?.proactiveSends).toBe("windowed");
  });
});

describe("inbound idempotency", () => {
  const envelope: InboundEnvelope = {
    channel: "telegram",
    providerMessageId: "msg-1",
    threadRef: "chat-1",
    senderRef: "+447911123456",
    text: "book dinner",
    receivedAt: 1,
  };

  // Providers retry webhooks; without this the user's request runs twice.
  it("is stable for the same provider message", () => {
    expect(inboundKey(envelope)).toBe(inboundKey({ ...envelope, receivedAt: 999 }));
  });

  it("differs across messages and across channels", () => {
    expect(inboundKey(envelope)).not.toBe(inboundKey({ ...envelope, providerMessageId: "msg-2" }));
    expect(inboundKey(envelope)).not.toBe(inboundKey({ ...envelope, channel: "whatsapp" }));
  });
});
