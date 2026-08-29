import { beforeEach, describe, expect, it } from "vitest";
import {
  inboundKey,
  SECRET_HEADER,
  TELEGRAM_MAX_MESSAGE,
  TelegramChannel,
  toTelegramHtml,
  type TelegramTransport,
} from "./index.js";

const SECRET = "webhook-secret-value";

interface Call {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

class FakeTransport implements TelegramTransport {
  calls: Call[] = [];
  nextId = 100;
  failCreateTopic = false;

  async call(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, payload });
    if (method === "createForumTopic") {
      if (this.failCreateTopic) throw new Error("not a forum supergroup");
      return { result: { message_thread_id: 42 } };
    }
    this.nextId += 1;
    return { result: { message_id: this.nextId } };
  }

  sent(): Call[] {
    return this.calls.filter((call) => call.method === "sendMessage");
  }
}

let transport: FakeTransport;
let channel: TelegramChannel;

beforeEach(() => {
  transport = new FakeTransport();
  channel = new TelegramChannel({
    transport,
    webhookSecret: SECRET,
    now: () => 1_700_000_000_000,
  });
});

function update(overrides: Record<string, unknown> = {}, secret: string = SECRET) {
  return {
    headers: { [SECRET_HEADER]: secret },
    body: {
      update_id: 1,
      message: {
        message_id: 7,
        date: 1_700_000_000,
        text: "book me a table",
        chat: { id: -100123 },
        from: { id: 555 },
        ...overrides,
      },
    },
  };
}

describe("an unauthenticated webhook never reaches the agent", () => {
  // Anyone can POST to a webhook URL.
  it("refuses a request with no secret header", async () => {
    await expect(channel.verifyAndNormalize({ headers: {}, body: update().body })).rejects.toThrow(
      /did not verify/iu
    );
  });

  it("refuses a request with the wrong secret", async () => {
    await expect(channel.verifyAndNormalize(update({}, "guessed"))).rejects.toThrow(
      /did not verify/iu
    );
  });

  // Verification must not depend on the payload being well-formed: a forged
  // request should be rejected before its contents influence anything.
  it("refuses a forged request even when the body is perfectly valid", async () => {
    await expect(channel.verifyAndNormalize(update({}, "wrong"))).rejects.toThrow(/verify/iu);
  });

  it("accepts a correctly signed request", async () => {
    const envelope = await channel.verifyAndNormalize(update());
    expect(envelope.text).toBe("book me a table");
  });

  // An adapter that accepts unsigned updates when misconfigured fails invisibly
  // until someone finds the URL.
  it("refuses to construct without a secret at all", () => {
    expect(() => new TelegramChannel({ transport, webhookSecret: "" })).toThrow(/secret/iu);
  });
});

describe("normalizing", () => {
  it("carries the sender, thread and text", async () => {
    const envelope = await channel.verifyAndNormalize(update());
    expect(envelope).toMatchObject({
      channel: "telegram",
      threadRef: "-100123",
      senderRef: "555",
      text: "book me a table",
    });
  });

  it("converts Telegram's seconds into milliseconds", async () => {
    const envelope = await channel.verifyAndNormalize(update());
    expect(envelope.receivedAt).toBe(1_700_000_000_000);
  });

  // Telegram reuses message ids across chats, so a bare id would let one chat's
  // retry suppress another chat's message.
  it("keys idempotency on chat and message together", async () => {
    const a = await channel.verifyAndNormalize(update());
    const b = await channel.verifyAndNormalize(update({ chat: { id: -100999 } }));

    expect(inboundKey(a)).not.toBe(inboundKey(b));
    expect(a.providerMessageId).toContain("-100123");
  });

  it("records the forum topic a message arrived in", async () => {
    const envelope = await channel.verifyAndNormalize(update({ message_thread_id: 42 }));
    expect(envelope.nativeThreadRef).toBe("42");
  });

  it("records what a message replied to", async () => {
    const envelope = await channel.verifyAndNormalize(
      update({ reply_to_message: { message_id: 3 } })
    );
    expect(envelope.replyToProviderMessageId).toBe("-100123:3");
  });

  it("falls back to the chat when there is no sender", async () => {
    const envelope = await channel.verifyAndNormalize(update({ from: undefined }));
    expect(envelope.senderRef).toBe("-100123");
  });

  // Telegram adds fields continually; rejecting unknown ones would turn a
  // routine platform change into an outage.
  it("tolerates fields it does not know about", async () => {
    const envelope = await channel.verifyAndNormalize(
      update({ some_new_field: { nested: true }, via_bot: { id: 9 } })
    );
    expect(envelope.text).toBe("book me a table");
  });

  it("rejects an update with no message", async () => {
    await expect(
      channel.verifyAndNormalize({ headers: { [SECRET_HEADER]: SECRET }, body: { update_id: 2 } })
    ).rejects.toThrow(/unsupported/iu);
  });

  it("rejects a message with no text, such as a sticker", async () => {
    await expect(channel.verifyAndNormalize(update({ text: undefined }))).rejects.toThrow(/text/iu);
  });
});

describe("per-task threads", () => {
  // The structural fix for one crowded conversation.
  it("opens a topic for a task and reuses it", async () => {
    expect(await channel.openTaskThread("-100123", "task-1", "Dinner Friday")).toBe(42);
    expect(await channel.openTaskThread("-100123", "task-1", "Dinner Friday")).toBe(42);

    const created = transport.calls.filter((call) => call.method === "createForumTopic");
    expect(created).toHaveLength(1);
  });

  it("places a task's messages in its own thread", async () => {
    await channel.openTaskThread("-100123", "task-1", "Dinner Friday");
    await channel.send("-100123", { text: "Booked for 8pm.", taskId: "task-1" });

    expect(transport.sent()[0]?.payload["message_thread_id"]).toBe(42);
  });

  it("sends to the main chat for a message with no task", async () => {
    await channel.send("-100123", { text: "Morning." });
    expect(transport.sent()[0]?.payload["message_thread_id"]).toBeUndefined();
  });

  // A plain group is not a forum. The agent must stay usable rather than fail
  // because a group setting is off.
  it("degrades to the main chat when topics are unavailable", async () => {
    transport.failCreateTopic = true;
    expect(await channel.openTaskThread("-100123", "task-1", "Dinner")).toBeUndefined();

    await channel.send("-100123", { text: "Booked.", taskId: "task-1" });
    expect(transport.sent()[0]?.payload["message_thread_id"]).toBeUndefined();
  });

  it("forgets a thread once the task is done", async () => {
    await channel.openTaskThread("-100123", "task-1", "Dinner");
    channel.closeTaskThread("task-1");

    await channel.send("-100123", { text: "Done.", taskId: "task-1" });
    expect(transport.sent()[0]?.payload["message_thread_id"]).toBeUndefined();
  });

  it("truncates an over-long topic title rather than being rejected", async () => {
    await channel.openTaskThread("-100123", "task-1", "T".repeat(400));
    const created = transport.calls.find((call) => call.method === "createForumTopic");
    expect(String(created?.payload["name"]).length).toBeLessThanOrEqual(128);
  });
});

describe("sending", () => {
  it("returns the provider id of what it sent", async () => {
    const receipt = await channel.send("-100123", { text: "Hello." });
    expect(receipt.providerMessageId).toBe("101");
    expect(receipt.deliveredAt).toBe(1_700_000_000_000);
  });

  // MarkdownV2 rejects a whole message over one unescaped character, which
  // would drop a reply the user is waiting on.
  it("uses the forgiving parse mode", async () => {
    await channel.send("-100123", { text: "Booked." });
    expect(transport.sent()[0]?.payload["parse_mode"]).toBe("HTML");
  });

  it("disables link previews", async () => {
    await channel.send("-100123", { text: "See https://example.com" });
    expect(transport.sent()[0]?.payload["link_preview_options"]).toEqual({ is_disabled: true });
  });

  // Providers reject oversized messages outright.
  it("splits a message past Telegram's cap", async () => {
    await channel.send("-100123", { text: "word ".repeat(2000) });

    const sent = transport.sent();
    expect(sent.length).toBeGreaterThan(1);
    for (const call of sent) {
      expect(String(call.payload["text"]).length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE);
    }
  });

  it("renders choices as buttons", async () => {
    await channel.send("-100123", {
      text: "Book it for £48?",
      taskId: "task-1",
      choices: ["Yes", "No"],
    });

    const markup = transport.sent()[0]?.payload["reply_markup"] as {
      inline_keyboard: { text: string }[][];
    };
    expect(markup.inline_keyboard[0]?.map((button) => button.text)).toEqual(["Yes", "No"]);
  });

  // Repeating buttons per chunk would offer the same approval several times.
  it("attaches buttons only to the final part of a split message", async () => {
    await channel.send("-100123", { text: "word ".repeat(2000), choices: ["Yes", "No"] });

    const sent = transport.sent();
    for (const call of sent.slice(0, -1)) {
      expect(call.payload["reply_markup"]).toBeUndefined();
    }
    expect(sent.at(-1)?.payload["reply_markup"]).toBeDefined();
  });

  it("keeps callback data within Telegram's limit", async () => {
    await channel.send("-100123", {
      text: "Confirm?",
      taskId: "t".repeat(200),
      choices: ["Yes"],
    });

    const markup = transport.sent()[0]?.payload["reply_markup"] as {
      inline_keyboard: { callback_data: string }[][];
    };
    expect(markup.inline_keyboard[0]?.[0]?.callback_data.length).toBeLessThanOrEqual(64);
  });
});

/**
 * Telegram's HTML parser rejects the whole message on a bare `&`, `<` or `>`,
 * and agent text is full of them: it quotes pages and carries URLs with query
 * strings. The failure is a 400 and total silence where a reply should be.
 */
describe("markdown becomes Telegram's HTML", () => {
  it("escapes the characters that would otherwise reject the message", () => {
    expect(toTelegramHtml("5 < 10 & 20 > 15")).toBe("5 &lt; 10 &amp; 20 &gt; 15");
  });

  it("escapes an ampersand in a URL, which is where they actually appear", async () => {
    await channel.send("-100123", { text: "https://air.example/book?a=1&b=2" });
    expect(String(transport.sent()[0]?.payload["text"])).toContain("a=1&amp;b=2");
  });

  it("survives page text that looks like markup", async () => {
    await channel.send("-100123", { text: "The page said <script>alert(1)</script>" });
    const sent = String(transport.sent()[0]?.payload["text"]);
    expect(sent).toContain("&lt;script&gt;");
    expect(sent).not.toContain("<script>");
  });

  // The bug this whole module exists to prevent, re-entering by another door.
  it("renders emphasis rather than showing literal asterisks", () => {
    expect(toTelegramHtml("**Booked** for *8pm*")).toBe("<b>Booked</b> for <i>8pm</i>");
  });

  it("renders links", () => {
    expect(toTelegramHtml("[receipt](https://air.example/r)")).toBe(
      '<a href="https://air.example/r">receipt</a>'
    );
  });

  // A link is the one place a message can carry a scheme; a client that honours
  // an unexpected one turns a chat message into a capability.
  it("does not emit a link for a non-http scheme", () => {
    // Falls back to inert visible text. The scheme still appears in the message
    // -- that is the point, the user sees exactly what was written -- but it is
    // not an anchor, so nothing can be tapped.
    const output = toTelegramHtml("[tap](javascript:alert(1))");
    expect(output).not.toContain("<a href");
    expect(output).toContain("[tap]");
  });

  it("leaves code spans unformatted", () => {
    expect(toTelegramHtml("run `npm test **now**`")).toBe("run <code>npm test **now**</code>");
  });

  it("escapes inside code too", () => {
    expect(toTelegramHtml("`a < b`")).toBe("<code>a &lt; b</code>");
  });

  it("turns headings into bold, since Telegram has none", () => {
    expect(toTelegramHtml("## Summary")).toBe("<b>Summary</b>");
  });

  it("turns bullets into a character every client renders", () => {
    expect(toTelegramHtml("- one\n- two")).toBe("• one\n• two");
  });

  it("does not mangle an ordinary sentence", () => {
    const plain = "Booked for 8pm at Rossi. Table for four, under your name.";
    expect(toTelegramHtml(plain)).toBe(plain);
  });

  // Escaping after tagging would escape the tags too: valid, and visibly wrong.
  it("does not escape the tags it just produced", () => {
    expect(toTelegramHtml("**a & b**")).toBe("<b>a &amp; b</b>");
  });
});
