/**
 * The translation between two tool-calling formats.
 *
 * Worth testing closely because every way it can go wrong is silent. A tool
 * result that does not name the call it answers is dropped by the far end and
 * the model asks for the same thing again — no error, just a loop and a bill. A
 * tool call whose arguments arrive as fragments and are never joined produces a
 * call with no input, which reads as the model failing rather than as us losing
 * half a string.
 */

import { describe, expect, it } from "vitest";
import { assistDialect } from "./assistant.js";
import {
  baseUrlFor,
  explainNoFiles,
  foldOpenAiStream,
  toOpenAiMessages,
  toOpenAiTools,
} from "./assist-openai.js";

describe("which format a model speaks", () => {
  it("routes by the vendor half of the catalog id", () => {
    expect(assistDialect("openai/gpt-5.6")).toEqual({
      vendor: "openai",
      model: "gpt-5.6",
      anthropic: false,
    });
    expect(assistDialect("anthropic/claude-sonnet-5").anthropic).toBe(true);
  });

  /**
   * Every caller passed a bare name before the vendor half was carried down
   * here. Treating that as Anthropic keeps them working; treating it as unknown
   * would have broken the one path that was already running.
   */
  it("treats a bare model name as Anthropic", () => {
    expect(assistDialect("claude-sonnet-4-5")).toEqual({
      vendor: "anthropic",
      model: "claude-sonnet-4-5",
      anthropic: true,
    });
  });

  it("knows where the compatible vendors live, and admits when it does not", () => {
    expect(baseUrlFor("openai")).toContain("api.openai.com");
    expect(baseUrlFor("deepseek")).toContain("api.deepseek.com");
    expect(baseUrlFor("self-hosted", "http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
    expect(baseUrlFor("self-hosted")).toBeUndefined();
    expect(baseUrlFor("midjourney")).toBeUndefined();
  });
});

describe("carrying a conversation across", () => {
  it("puts the system prompt first, where this format wants it", () => {
    const out = toOpenAiMessages("today is Tuesday", [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(out[0]).toEqual({ role: "system", content: "today is Tuesday" });
    expect(out[1]).toEqual({ role: "user", content: "hello" });
  });

  it("turns an assistant turn with a tool call into content plus tool_calls", () => {
    const out = toOpenAiMessages("s", [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "monkeys" } },
        ],
      },
    ]);

    expect(out[1]).toEqual({
      role: "assistant",
      content: "Let me look.",
      tool_calls: [
        {
          id: "tu_1",
          type: "function",
          function: { name: "web_search", arguments: '{"query":"monkeys"}' },
        },
      ],
    });
  });

  /**
   * The expensive one. Anthropic carries results as blocks inside a single user
   * turn; this format wants one `tool` message each, naming the call it answers.
   * Collapsing them loses the correspondence, the far end drops what it cannot
   * match, and the model asks again — a loop with no error anywhere in it.
   */
  it("splits a turn of results into one message per call", () => {
    const out = toOpenAiMessages("s", [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "eight results" },
          { type: "tool_result", tool_use_id: "tu_2", content: "downloaded monkey.jpg" },
        ],
      },
    ]);

    expect(out.slice(1)).toEqual([
      { role: "tool", tool_call_id: "tu_1", content: "eight results" },
      { role: "tool", tool_call_id: "tu_2", content: "downloaded monkey.jpg" },
    ]);
  });

  /**
   * An assistant turn that is nothing but tool calls sends `content: null`.
   * Some endpoints reject an empty string there, and the failure is a 400 in the
   * middle of a task rather than anything a reader would connect to this line.
   */
  it("sends null content rather than an empty string when only tools were called", () => {
    const out = toOpenAiMessages("s", [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] },
    ]);
    expect((out[1] as { content: unknown }).content).toBeNull();
  });

  it("describes our tools in the shape this format expects", () => {
    expect(
      toOpenAiTools([
        {
          name: "fetch_url",
          description: "Read a URL.",
          inputSchema: { type: "object", properties: { url: { type: "string" } } },
          run: async () => ({ text: "" }),
        },
      ])
    ).toEqual([
      {
        type: "function",
        function: {
          name: "fetch_url",
          description: "Read a URL.",
          parameters: { type: "object", properties: { url: { type: "string" } } },
        },
      },
    ]);
  });
});

/** One `data:` frame as the endpoint sends it. */
const delta = (choice: Record<string, unknown>) => ({ choices: [choice] });

describe("folding the stream back into blocks", () => {
  it("joins text deltas into one block", () => {
    const folded = foldOpenAiStream([
      delta({ delta: { content: "Reykjavik has " } }),
      delta({ delta: { content: "249,228 people." } }),
      delta({ delta: {}, finish_reason: "stop" }),
    ]);

    expect(folded.content).toEqual([{ type: "text", text: "Reykjavik has 249,228 people." }]);
    expect(folded.stopReason).toBe("stop");
  });

  /**
   * Arguments arrive as string fragments across many frames and are only valid
   * once joined. Parsing each fragment would fail on all of them; parsing the
   * concatenation is the whole trick.
   */
  it("reassembles tool arguments split across frames", () => {
    const folded = foldOpenAiStream([
      delta({
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "web_search" } }] },
      }),
      delta({ delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } }),
      delta({ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"monkey"}' } }] } }),
      delta({ delta: {}, finish_reason: "tool_calls" }),
    ]);

    expect(folded.content).toEqual([
      { type: "tool_use", id: "call_1", name: "web_search", input: { query: "monkey" } },
    ]);
    // Mapped to the vocabulary the loop already speaks.
    expect(folded.stopReason).toBe("tool_use");
  });

  it("keeps two concurrent calls apart by index", () => {
    const folded = foldOpenAiStream([
      delta({
        delta: {
          tool_calls: [
            { index: 0, id: "a", function: { name: "web_search", arguments: "{}" } },
            { index: 1, id: "b", function: { name: "fetch_url", arguments: "{}" } },
          ],
        },
      }),
    ]);
    expect(folded.content.map((block) => block["name"])).toEqual(["web_search", "fetch_url"]);
  });

  /**
   * `length` is this format's way of saying the output ceiling was hit, and the
   * loop already knows to treat that as a failure rather than an answer — a
   * truncated reply that produced nothing was once returned `ok: true`.
   */
  it("maps a truncated turn onto the stop reason the loop acts on", () => {
    expect(foldOpenAiStream([delta({ delta: {}, finish_reason: "length" })]).stopReason).toBe(
      "max_tokens"
    );
  });

  /** A call whose JSON never completed is left without input rather than guessed at. */
  it("does not invent arguments it could not parse", () => {
    const folded = foldOpenAiStream([
      delta({
        delta: { tool_calls: [{ index: 0, id: "a", function: { name: "x", arguments: '{"q' } }] },
      }),
    ]);
    expect(folded.content[0]).toEqual({ type: "tool_use", id: "a", name: "x" });
  });

  it("ignores a frame it cannot read rather than losing the response", () => {
    const folded = foldOpenAiStream([
      { nonsense: true },
      delta({ delta: { content: "still here" } }),
    ]);
    expect(folded.content).toEqual([{ type: "text", text: "still here" }]);
  });
});

describe("attachments this path cannot carry", () => {
  /**
   * There is no container to upload into, so the model is told rather than left
   * to answer confidently about a document it was never shown — the failure this
   * codebase has spent the most effort removing.
   */
  it("says which files could not be opened", () => {
    const note = explainNoFiles([
      { name: "resume.pdf", mediaType: "application/pdf", data: new Uint8Array([1]) },
    ]);
    expect(note).toContain("resume.pdf");
    expect(note).toContain("no sandbox");
  });

  it("says nothing when nothing was attached", () => {
    expect(explainNoFiles([])).toBeUndefined();
  });
});
