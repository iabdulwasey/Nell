import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  chooseSendMode,
  SERVICE_WINDOW_MS,
  SIGNATURE_HEADER,
  toWhatsAppFormatting,
  WhatsAppChannel,
  WHATSAPP_MAX_MESSAGE,
  type WhatsAppTransport,
} from "./index.js";

const SECRET = "app-secret";
const NOW = 1_700_000_000_000;
const USER = "447700900123";

class FakeTransport implements WhatsAppTransport {
  sent: Record<string, unknown>[] = [];
  async send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push(payload);
    return { messages: [{ id: `wamid.${String(this.sent.length)}` }] };
  }
}

let transport: FakeTransport;
let channel: WhatsAppChannel;
let clock = NOW;

beforeEach(() => {
  transport = new FakeTransport();
  clock = NOW;
  channel = new WhatsAppChannel({ transport, appSecret: SECRET, now: () => clock });
});

function request(overrides: Record<string, unknown> = {}, secret = SECRET) {
  const body = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "wamid.in1",
                  from: USER,
                  timestamp: String(Math.floor(NOW / 1000)),
                  type: "text",
                  text: { body: "book me a table" },
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  });

  return {
    headers: {
      [SIGNATURE_HEADER]: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    rawBody: body,
  };
}

describe("webhook authenticity", () => {
  it("accepts a correctly signed request", async () => {
    const envelope = await channel.verifyAndNormalize(request());
    expect(envelope.text).toBe("book me a table");
  });

  it("refuses a wrong signature", async () => {
    await expect(channel.verifyAndNormalize(request({}, "guessed"))).rejects.toThrow(/verify/iu);
  });

  it("refuses a missing signature", async () => {
    const { rawBody } = request();
    await expect(channel.verifyAndNormalize({ headers: {}, rawBody })).rejects.toThrow(/verify/iu);
  });

  /**
   * The signature covers the bytes that arrived. Verifying a re-serialised
   * object is the classic way to build a check that passes on forgeries too —
   * so a body whose signature was computed over different bytes must fail even
   * though the parsed object is identical.
   */
  it("verifies the raw bytes, not the parsed object", async () => {
    const original = request();
    const reserialized = JSON.stringify(JSON.parse(original.rawBody), null, 2);

    await expect(
      channel.verifyAndNormalize({ headers: original.headers, rawBody: reserialized })
    ).rejects.toThrow(/verify/iu);
  });

  it("refuses to construct without a secret", () => {
    expect(() => new WhatsAppChannel({ transport, appSecret: "" })).toThrow(/secret/iu);
  });

  it("rejects a payload with no text", async () => {
    await expect(
      channel.verifyAndNormalize(request({ type: "image", text: undefined }))
    ).rejects.toThrow(/text/iu);
  });
});

describe("the 24-hour service window", () => {
  /**
   * The failure that matters most for a proactive agent: outside the window a
   * freeform send is accepted by the API and never delivered. No error, no
   * bounce — the user simply never learns their task finished.
   */
  it("sends freeform inside the window", () => {
    expect(chooseSendMode(NOW, NOW + 60_000, false).kind).toBe("freeform");
  });

  it("falls back to a template outside it", () => {
    const mode = chooseSendMode(NOW, NOW + SERVICE_WINDOW_MS + 1, false);
    expect(mode.kind).toBe("template");
    if (mode.kind === "template") expect(mode.reason).toContain("silently never delivered");
  });

  it("treats someone who has never written as outside the window", () => {
    const mode = chooseSendMode(undefined, NOW, false);
    expect(mode.kind).toBe("template");
    if (mode.kind === "template") expect(mode.reason).toContain("never messaged");
  });

  it("uses the right template for something that needs an answer", () => {
    const mode = chooseSendMode(undefined, NOW, true);
    if (mode.kind === "template") expect(mode.template.name).toBe("needs_you");
  });

  it("reopens the window when the user writes", async () => {
    expect(channel.canSpeakFreely(USER)).toBe(false);
    await channel.verifyAndNormalize(request());
    expect(channel.canSpeakFreely(USER)).toBe(true);
  });

  it("closes again once the window lapses", async () => {
    await channel.verifyAndNormalize(request());
    clock = NOW + SERVICE_WINDOW_MS + 1;
    expect(channel.canSpeakFreely(USER)).toBe(false);
  });

  it("actually sends a template rather than freeform text when closed", async () => {
    await channel.send(USER, { text: "Your table is booked.", taskLabel: "Dinner" });

    const payload = transport.sent[0];
    expect(payload?.["type"]).toBe("template");
    expect(payload?.["text"]).toBeUndefined();
  });

  // A template is approved once and cannot be edited, so it carries a label and
  // the substance waits for the user to reply.
  it("puts the task label in the template parameter", async () => {
    await channel.send(USER, { text: "Long update.", taskLabel: "Dinner" });
    expect(JSON.stringify(transport.sent[0])).toContain("Dinner");
  });

  it("sends real text once the window is open", async () => {
    await channel.verifyAndNormalize(request());
    await channel.send(USER, { text: "Your table is booked." });

    expect(transport.sent[0]?.["type"]).toBe("text");
    expect(JSON.stringify(transport.sent[0])).toContain("Your table is booked.");
  });

  it("can have window state restored on boot", () => {
    channel.noteInbound(USER, NOW);
    expect(channel.canSpeakFreely(USER)).toBe(true);
  });
});

describe("formatting", () => {
  /**
   * WhatsApp renders `**bold**` as two literal asterisks, the word, and two
   * more. Its own bold is a single asterisk.
   */
  it("converts markdown bold into WhatsApp bold", () => {
    expect(toWhatsAppFormatting("**Booked**")).toBe("*Booked*");
    expect(toWhatsAppFormatting("__Booked__")).toBe("*Booked*");
  });

  it("converts markdown italic into WhatsApp italic", () => {
    expect(toWhatsAppFormatting("*8pm*")).toBe("_8pm_");
  });

  /**
   * The order is load-bearing: converting single asterisks first turns
   * `**bold**` into `*_bold_*`, which renders as an italic word wrapped in
   * stray asterisks.
   */
  it("does not mangle bold by treating it as italic", () => {
    const output = toWhatsAppFormatting("**Booked** for *8pm*");
    expect(output).toBe("*Booked* for _8pm_");
    expect(output).not.toContain("*_");
  });

  it("never leaves a markdown marker behind", () => {
    const output = toWhatsAppFormatting("## Heading\n**a** __b__ ~~c~~\n- e");
    expect(output).not.toContain("**");
    expect(output).not.toContain("__");
    expect(output).not.toContain("~~");
    expect(output).not.toContain("##");
  });

  // WhatsApp has no anchor syntax, so both halves of a link have to survive or
  // the message loses one of them.
  it("keeps both the label and the URL of a link", () => {
    const output = toWhatsAppFormatting("[Rossi](https://rossi.example)");
    expect(output).toContain("Rossi");
    expect(output).toContain("https://rossi.example");
  });

  it("leaves an asterisk inside code alone", () => {
    expect(toWhatsAppFormatting("run `a * b`")).toBe("run ```a * b```");
  });

  it("keeps bullets as a character every client renders", () => {
    expect(toWhatsAppFormatting("- one\n- two")).toBe("• one\n• two");
  });

  it("does not mangle an ordinary sentence", () => {
    const plain = "Booked for 8pm at Rossi, table for four.";
    expect(toWhatsAppFormatting(plain)).toBe(plain);
  });
});

describe("sending", () => {
  beforeEach(async () => {
    await channel.verifyAndNormalize(request());
  });

  it("splits past the platform cap", async () => {
    await channel.send(USER, { text: "word ".repeat(2000) });

    expect(transport.sent.length).toBeGreaterThan(1);
    for (const payload of transport.sent) {
      const text = (payload["text"] as { body: string } | undefined)?.body ?? "";
      expect(text.length).toBeLessThanOrEqual(WHATSAPP_MAX_MESSAGE);
    }
  });

  it("renders choices as reply buttons", async () => {
    await channel.send(USER, { text: "Book it?", taskId: "t-1", choices: ["Yes", "No"] });

    const payload = transport.sent.at(-1);
    expect(payload?.["type"]).toBe("interactive");
    expect(JSON.stringify(payload)).toContain("Yes");
  });

  // WhatsApp permits at most three reply buttons and truncates titles.
  it("stays within the platform's button limits", async () => {
    await channel.send(USER, {
      text: "Pick one",
      taskId: "t-1",
      choices: ["A".repeat(40), "B", "C", "D", "E"],
    });

    const interactive = transport.sent.at(-1)?.["interactive"] as {
      action: { buttons: { reply: { title: string } }[] };
    };
    expect(interactive.action.buttons).toHaveLength(3);
    expect(interactive.action.buttons[0]?.reply.title.length).toBeLessThanOrEqual(20);
  });

  // Repeating buttons per chunk would offer the same approval several times.
  it("attaches buttons only to the last part", async () => {
    await channel.send(USER, { text: "word ".repeat(2000), choices: ["Yes"] });

    const withButtons = transport.sent.filter((payload) => payload["type"] === "interactive");
    expect(withButtons).toHaveLength(1);
    expect(transport.sent.at(-1)?.["type"]).toBe("interactive");
  });

  it("disables link previews", async () => {
    await channel.send(USER, { text: "https://rossi.example" });
    expect((transport.sent[0]?.["text"] as { preview_url: boolean }).preview_url).toBe(false);
  });
});
