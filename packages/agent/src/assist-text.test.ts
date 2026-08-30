/**
 * How a reply is assembled out of the blocks it arrives in.
 *
 * Invisible until the day server-side search was switched on, and then
 * immediately the ugliest thing in the product. The vendor **splits a sentence
 * around each citation**, so one sentence arrives as several `text` blocks — and
 * joining those with a blank line turned
 *
 *     There's a Dense Fog Advisory active today, with cloudy skies early
 *
 * into five paragraphs, with the comma and the full stop stranded on lines of
 * their own. Reported as "formatting in Telegram isn't perfect". The renderer
 * was fine; the text handed to it was already wrong.
 *
 * The distinction the fix rests on: a blank line separates **turns** — points
 * where the model genuinely stopped to use a tool — and not blocks, which are an
 * artefact of how the response was chunked.
 */

import { describe, expect, it } from "vitest";
import { assist } from "./assistant.js";

/** Streams a prepared set of Anthropic events, so block layout is exact. */
function streaming(frames: readonly string[]): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    )) as unknown as typeof fetch;
}

const textBlock = (index: number, text: string) => [
  JSON.stringify({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  }),
  JSON.stringify({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  }),
];

const ask = async (frames: readonly string[]) =>
  assist({
    apiKey: "k",
    model: "anthropic/claude-sonnet-4-5",
    system: "s",
    prompt: "p",
    fetchImpl: streaming(frames),
  });

describe("a sentence split by citations", () => {
  it("comes back as one sentence, not one paragraph per fragment", async () => {
    const outcome = await ask([
      ...textBlock(0, "There's a Dense Fog Advisory active today"),
      ...textBlock(1, ", with "),
      ...textBlock(2, "cloudy skies early becoming partly cloudy later"),
      ...textBlock(3, "."),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.text).toBe(
      "There's a Dense Fog Advisory active today, with cloudy skies early becoming partly cloudy later."
    );
    // The symptom, stated directly: no punctuation stranded on its own line.
    expect(outcome.text).not.toMatch(/\n\s*[,.]/u);
  });

  it("keeps the model's own paragraph breaks", async () => {
    const outcome = await ask([
      ...textBlock(0, "First paragraph.\n\nSecond paragraph."),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    expect(outcome.ok && outcome.text).toBe("First paragraph.\n\nSecond paragraph.");
  });

  /**
   * Narration before a tool is dropped once a real answer arrives, and that is
   * deliberate rather than incidental — "let me check the forecast" is the model
   * talking to itself, and nobody wants it prepended to the answer.
   *
   * Asserted here because it is the property the concatenation must not break:
   * fragments of one sentence join, and the two sides of a tool call do not.
   * Getting that backwards would either re-fragment sentences or start every
   * answer with the model announcing what it was about to do.
   */
  it("drops narration from before a tool call, and keeps the answer whole", async () => {
    const outcome = await ask([
      ...textBlock(0, "Let me check the forecast."),
      JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "server_tool_use", name: "web_search", id: "s1" },
      }),
      ...textBlock(2, "Fog is clearing"),
      ...textBlock(3, " by five."),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    expect(outcome.ok && outcome.text).toBe("Fog is clearing by five.");
  });

  /** With nothing said afterwards, the narration is better than silence. */
  it("falls back to the narration when the model never spoke again", async () => {
    const outcome = await ask([
      ...textBlock(0, "I looked, and found nothing."),
      JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "server_tool_use", name: "web_search", id: "s1" },
      }),
      JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    expect(outcome.ok && outcome.text).toBe("I looked, and found nothing.");
  });
});
