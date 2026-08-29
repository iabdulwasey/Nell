/**
 * What actually leaves for Telegram.
 *
 * The agent writes markdown — the sensible internal format for something that
 * speaks over five apps with five different notions of formatting — and this is
 * the edge where it becomes one of them. Before this existed the text went out
 * verbatim, so replies arrived reading `**Top Stories:**` and `1. **NASA...**`.
 */

import { describe, expect, it } from "vitest";
import { sendMessage } from "./telegram-poll.js";

interface Sent {
  readonly text: string;
  readonly parse_mode?: string;
}

/** Records what was posted, and can be told which attempts Telegram rejects. */
function recorder(reject: (body: Sent) => boolean = () => false) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    return new Response(JSON.stringify({ ok: !reject(body) }), {
      status: reject(body) ? 400 : 200,
    });
  };
  return { sent, fetchImpl };
}

const to = (fetchImpl: typeof fetch, text: string) =>
  sendMessage({ token: "t", chatId: "c", text, fetchImpl });

describe("formatting a reply for Telegram", () => {
  it("turns markdown into Telegram's HTML rather than sending the asterisks", async () => {
    const { sent, fetchImpl } = recorder();

    await to(fetchImpl, "**Top Stories**\n\n- NASA did a thing\n- DNA memory device");

    expect(sent[0]?.parse_mode).toBe("HTML");
    expect(sent[0]?.text).toContain("<b>Top Stories</b>");
    expect(sent[0]?.text).toContain("•");
    expect(sent[0]?.text).not.toContain("**");
  });

  it("renders headings as bold, since Telegram has no headings", async () => {
    const { sent, fetchImpl } = recorder();
    await to(fetchImpl, "## Today's news\n\nSomething happened.");
    expect(sent[0]?.text).toContain("<b>Today's news</b>");
    expect(sent[0]?.text).not.toContain("##");
  });

  /**
   * The failure that made this necessary. Telegram rejects the *whole* message
   * with a 400 on a bare `&`, `<` or `>` — and agent text is full of them, since
   * it quotes pages and carries URLs with query strings. The reply never arrives
   * and the only symptom is silence.
   */
  it("escapes the characters that would otherwise lose the message", async () => {
    const { sent, fetchImpl } = recorder();

    await to(fetchImpl, "Results for M&S <see here>: https://x.com/?a=1&b=2");

    expect(sent[0]?.text).toContain("&amp;");
    expect(sent[0]?.text).toContain("&lt;see here&gt;");
  });

  /**
   * The important one. If Telegram rejects the HTML for any reason, the user
   * gets nothing — not an error, silence, on a reply they are waiting for. Ugly
   * beats absent.
   */
  it("falls back to plain text when the formatted send is rejected", async () => {
    const { sent, fetchImpl } = recorder((body) => body.parse_mode === "HTML");

    const ok = await to(fetchImpl, "**Bold** and a [link](https://example.com)");

    expect(sent).toHaveLength(2);
    expect(sent[0]?.parse_mode).toBe("HTML");
    // The retry carries no parse mode at all, so there is nothing left to reject.
    expect(sent[1]?.parse_mode).toBeUndefined();
    expect(sent[1]?.text).not.toContain("<b>");
    expect(sent[1]?.text).toContain("Bold");
    expect(ok).toBe(true);
  });

  it("reports failure when even the plain retry does not land", async () => {
    const { fetchImpl } = recorder(() => true);
    expect(await to(fetchImpl, "hello")).toBe(false);
  });

  /**
   * A long answer — a day of headlines, a list of showtimes — is exactly what
   * this agent produces, and an oversized message is rejected whole rather than
   * truncated.
   */
  it("splits a long answer into messages that each fit", async () => {
    const { sent, fetchImpl } = recorder();

    const paragraphs = Array.from(
      { length: 60 },
      (_, i) => `Story ${String(i)}. ${"x".repeat(90)}`
    );
    await to(fetchImpl, paragraphs.join("\n\n"));

    expect(sent.length).toBeGreaterThan(1);
    for (const message of sent) expect(message.text.length).toBeLessThanOrEqual(4096);
  });

  it("sends a short reply as exactly one message", async () => {
    const { sent, fetchImpl } = recorder();
    await to(fetchImpl, "On it.");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe("On it.");
  });
});
