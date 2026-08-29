import { beforeEach, describe, expect, it } from "vitest";
import {
  complianceKeyword,
  complianceReply,
  IMessageChannel,
  IMESSAGE_MAX_MESSAGE,
  IMESSAGE_SIGNATURE_HEADER,
  type IMessageTransport,
  type InboundEnvelope,
} from "./index.js";

const SECRET = "imessage-secret";
const NOW = 1_700_000_000_000;
const USER = "+447700900123";

class FakeTransport implements IMessageTransport {
  sent: Record<string, unknown>[] = [];
  groups: { participants: readonly string[]; name: string }[] = [];
  canGroup = true;

  async send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push(payload);
    return { message_id: `im-${String(this.sent.length)}` };
  }

  createGroup = async (participants: readonly string[], name: string): Promise<string> => {
    if (!this.canGroup) throw new Error("groups unavailable");
    this.groups.push({ participants, name });
    return `group-${String(this.groups.length)}`;
  };

  texts(): string[] {
    return this.sent.map((payload) => String(payload["content"]));
  }
}

let transport: FakeTransport;
let channel: IMessageChannel;

beforeEach(() => {
  transport = new FakeTransport();
  channel = new IMessageChannel({ transport, webhookSecret: SECRET, now: () => NOW });
});

function event(overrides: Record<string, unknown> = {}, secret = SECRET) {
  return {
    headers: { [IMESSAGE_SIGNATURE_HEADER]: secret },
    body: {
      message_id: "im-in-1",
      from: USER,
      content: "book me a table",
      received_at: NOW,
      ...overrides,
    },
  };
}

async function inbound(text: string): Promise<InboundEnvelope> {
  return channel.verifyAndNormalize(event({ content: text }));
}

describe("webhook authenticity", () => {
  it("accepts a correctly signed event", async () => {
    expect((await channel.verifyAndNormalize(event())).text).toBe("book me a table");
  });

  it("refuses a wrong or missing secret", async () => {
    await expect(channel.verifyAndNormalize(event({}, "guessed"))).rejects.toThrow(/verify/iu);
    await expect(channel.verifyAndNormalize({ headers: {}, body: event().body })).rejects.toThrow(
      /verify/iu
    );
  });

  it("refuses to construct without a secret", () => {
    expect(() => new IMessageChannel({ transport, webhookSecret: "" })).toThrow(/secret/iu);
  });

  it("rejects an event with no text", async () => {
    await expect(channel.verifyAndNormalize(event({ content: "  " }))).rejects.toThrow(/text/iu);
  });

  it("routes a group message to its group", async () => {
    const envelope = await channel.verifyAndNormalize(event({ group_id: "chat-9" }));
    expect(envelope.threadRef).toBe("chat-9");
    expect(envelope.senderRef).toBe(USER);
    expect(envelope.nativeThreadRef).toBe("chat-9");
  });
});

describe("no formatting reaches the bubble", () => {
  /**
   * iMessage renders `**bold**` as four asterisks and the word between them.
   * This is a documented, visible bug in a shipped agent, and the reason the
   * renderer exists.
   */
  it("flattens markdown unconditionally", async () => {
    await channel.send(USER, {
      text: "**Booked** for _8pm_ at [Rossi](https://rossi.example)",
    });

    const text = transport.texts()[0] ?? "";
    expect(text).not.toContain("**");
    expect(text).not.toContain("](");
    expect(text).toContain("Booked");
    // The URL survives, because a link the user cannot tap is a broken message.
    expect(text).toContain("https://rossi.example");
  });

  // There are no buttons here; "tap yes" with nothing to tap is worse than a
  // plain question.
  it("renders choices as numbered lines", async () => {
    await channel.send(USER, { text: "Book it?", choices: ["Yes", "No"] });

    const text = transport.texts()[0] ?? "";
    expect(text).toContain("1. Yes");
    expect(text).toContain("2. No");
  });

  // A wall of text in a chat bubble is unreadable in a way the same text in a
  // web panel is not.
  it("splits well below the transport limit", async () => {
    await channel.send(USER, { text: "word ".repeat(1000) });

    expect(transport.sent.length).toBeGreaterThan(1);
    for (const text of transport.texts()) {
      expect(text.length).toBeLessThanOrEqual(IMESSAGE_MAX_MESSAGE);
    }
  });
});

describe("carrier compliance", () => {
  // These are law in several jurisdictions, not product decisions.
  it("recognises the required keywords", () => {
    for (const word of ["STOP", "stop", "Stop.", "unsubscribe", "CANCEL", "quit"]) {
      expect(complianceKeyword(word)).toBe("stop");
    }
    expect(complianceKeyword("START")).toBe("start");
    expect(complianceKeyword("help")).toBe("help");
  });

  /**
   * Matched on the whole message and nothing else. "Stop by the shop on the way"
   * is not an opt-out, and treating it as one silently disconnects someone
   * mid-conversation.
   */
  it("does not mistake a sentence containing the word for an opt-out", () => {
    for (const text of [
      "stop by the shop on the way",
      "can you stop the subscription",
      "help me book a table",
      "start looking for flights",
    ]) {
      expect(complianceKeyword(text)).toBeUndefined();
    }
  });

  /**
   * A STOP answered by a model explaining what it was working on is a
   * violation — which is exactly what a system treating these as ordinary
   * messages would produce.
   */
  it("answers with fixed text rather than routing to the agent", async () => {
    const reply = channel.handleCompliance(await inbound("STOP"));

    expect(reply).toBe(complianceReply("stop"));
    expect(reply).toContain("unsubscribed");
    expect(reply).toContain("START");
  });

  it("returns nothing for an ordinary message, so it reaches the agent", async () => {
    expect(channel.handleCompliance(await inbound("book me a table"))).toBeUndefined();
  });

  // Silence after an opt-out is the entire point of an opt-out.
  it("goes silent after STOP", async () => {
    channel.handleCompliance(await inbound("STOP"));
    expect(channel.hasOptedOut(USER)).toBe(true);

    await channel.send(USER, { text: "Your table is booked." });
    expect(transport.sent).toHaveLength(0);
  });

  it("speaks again after START", async () => {
    channel.handleCompliance(await inbound("STOP"));
    channel.handleCompliance(await inbound("START"));

    expect(channel.hasOptedOut(USER)).toBe(false);
    await channel.send(USER, { text: "Booked." });
    expect(transport.sent).toHaveLength(1);
  });

  it("keeps talking after HELP, which is not an opt-out", async () => {
    channel.handleCompliance(await inbound("HELP"));
    expect(channel.hasOptedOut(USER)).toBe(false);
  });
});

describe("per-task group chats", () => {
  // The only way to get per-task threads on the channel most people use;
  // Telegram's topics do not transfer.
  it("opens a group for a task and reuses it", async () => {
    expect(await channel.openTaskThread([USER], "t-1", "Dinner Friday")).toBe("group-1");
    expect(await channel.openTaskThread([USER], "t-1", "Dinner Friday")).toBe("group-1");
    expect(transport.groups).toHaveLength(1);
  });

  it("sends a task's messages to its group", async () => {
    await channel.openTaskThread([USER], "t-1", "Dinner");
    await channel.send(USER, { text: "Booked.", taskId: "t-1" });

    expect(transport.sent[0]?.["to"]).toBe("group-1");
  });

  // An agent that stops working over a missing nicety is worse than a crowded
  // thread.
  it("falls back to the direct thread when groups are unavailable", async () => {
    transport.canGroup = false;
    expect(await channel.openTaskThread([USER], "t-1", "Dinner")).toBeUndefined();

    await channel.send(USER, { text: "Booked.", taskId: "t-1" });
    expect(transport.sent[0]?.["to"]).toBe(USER);
  });

  it("forgets the group when the task ends", async () => {
    await channel.openTaskThread([USER], "t-1", "Dinner");
    channel.closeTaskThread("t-1");

    await channel.send(USER, { text: "Done.", taskId: "t-1" });
    expect(transport.sent[0]?.["to"]).toBe(USER);
  });

  // Inside a task's own group the label is noise; in a shared thread it is how
  // the user tells three running tasks apart.
  it("tags the task only outside its own group", async () => {
    await channel.send(USER, { text: "Booked.", taskLabel: "Dinner", emoji: "🍝" });
    expect(transport.texts()[0]).toContain("Dinner:");

    await channel.openTaskThread([USER], "t-1", "Dinner");
    await channel.send(USER, { text: "Booked.", taskLabel: "Dinner", taskId: "t-1" });
    expect(transport.texts()[1]).not.toContain("Dinner:");
  });
});
