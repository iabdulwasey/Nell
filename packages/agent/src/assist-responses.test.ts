/**
 * Running code somewhere other than Anthropic.
 *
 * The last vendor-bound capability, and it needed a *third* transport rather
 * than an option on the second: the container lives behind the Responses API,
 * which is a different endpoint from chat completions with a different request
 * shape and a different way of handing files back.
 *
 * The case that gets most attention here is the file citation. This endpoint
 * does not attach what the code wrote — it *mentions* it, with a container id
 * and a file id, and the bytes are a second call. A transport that stopped at
 * the citation would produce the exact failure this codebase has already
 * shipped once: a confident reply naming a PDF that never arrives.
 */

import { describe, expect, it } from "vitest";
import { assistDialect } from "./assistant.js";
import {
  downloadContainerFile,
  foldResponsesOutput,
  toResponsesInput,
  toResponsesTools,
} from "./assist-responses.js";

describe("which endpoint a model speaks", () => {
  it("sends OpenAI to Responses and everyone else to chat completions", () => {
    expect(assistDialect("openai/gpt-5.6").responses).toBe(true);
    expect(assistDialect("deepseek/deepseek-chat").responses).toBe(false);
    expect(assistDialect("anthropic/claude-sonnet-5").responses).toBe(false);
  });
});

describe("the tools, in this endpoint's shape", () => {
  /**
   * A function tool is *flat* here, where chat completions nests the same fields
   * under `function`. Two formats from one vendor, and the wrong one is a 400
   * rather than a warning.
   */
  it("describes a function tool flat, not nested", () => {
    const [tool] = toResponsesTools(
      [
        {
          name: "fetch_url",
          description: "Read a URL.",
          inputSchema: { type: "object" },
          run: async () => ({ text: "" }),
        },
      ],
      { search: false, code: false }
    );

    expect(tool).toEqual({
      type: "function",
      name: "fetch_url",
      description: "Read a URL.",
      parameters: { type: "object" },
    });
  });

  it("asks for a container only when code is wanted", () => {
    const withCode = toResponsesTools([], { search: false, code: true });
    expect(withCode[0]).toEqual({ type: "code_interpreter", container: { type: "auto" } });
    expect(toResponsesTools([], { search: false, code: false })).toHaveLength(0);
  });
});

describe("carrying a conversation across", () => {
  it("turns a tool result into an output naming the call it answers", () => {
    const input = toResponsesInput([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "eight results" }],
      },
    ]);

    expect(input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "eight results" },
    ]);
  });

  /** The two roles want different content types; the wrong one is rejected. */
  it("uses input_text for the user and output_text for the assistant", () => {
    const input = toResponsesInput([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);

    expect((input[0] as { content: { type: string }[] }).content[0]?.type).toBe("input_text");
    expect((input[1] as { content: { type: string }[] }).content[0]?.type).toBe("output_text");
  });

  it("carries an assistant tool call as its own item", () => {
    const input = toResponsesInput([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_2", name: "lookup", input: { of: "x" } }],
      },
    ]);

    expect(input[0]).toEqual({
      type: "function_call",
      call_id: "call_2",
      name: "lookup",
      arguments: '{"of":"x"}',
    });
  });
});

describe("reading the finished response", () => {
  it("turns text and a function call into the blocks the loop understands", () => {
    const folded = foldResponsesOutput({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Here you go." }] },
        { type: "function_call", call_id: "c1", name: "lookup", arguments: '{"of":"x"}' },
      ],
    });

    expect(folded.content).toEqual([
      { type: "text", text: "Here you go." },
      { type: "tool_use", id: "c1", name: "lookup", input: { of: "x" } },
    ]);
    expect(folded.stopReason).toBe("tool_use");
  });

  /**
   * The one that matters. The container's output is *cited*, not attached, and a
   * transport that ignored annotations would return a reply describing a file
   * nobody receives.
   */
  it("finds the files the code wrote, which are cited rather than attached", () => {
    const folded = foldResponsesOutput({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "I made the chart.",
              annotations: [
                {
                  type: "container_file_citation",
                  container_id: "cntr_1",
                  file_id: "cfile_9",
                  filename: "revenue.png",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(folded.files).toEqual([
      { containerId: "cntr_1", fileId: "cfile_9", filename: "revenue.png" },
    ]);
  });

  /**
   * A truncated reply is a failure rather than an answer — the rule the
   * Anthropic path learned by shipping the opposite, in this endpoint's spelling.
   */
  it("reports a run that hit the ceiling as truncated", () => {
    const folded = foldResponsesOutput({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "Now I'll c" }] }],
    });
    expect(folded.stopReason).toBe("max_tokens");
  });

  it("returns nothing rather than throwing on a shape it does not know", () => {
    expect(foldResponsesOutput({ nonsense: true })).toEqual({
      content: [],
      stopReason: undefined,
      files: [],
    });
  });

  /** Arguments that never parsed leave the call without input, rather than guessed. */
  it("does not invent arguments it could not read", () => {
    const folded = foldResponsesOutput({
      output: [{ type: "function_call", call_id: "c1", name: "x", arguments: '{"q' }],
    });
    expect(folded.content[0]).toEqual({ type: "tool_use", id: "c1", name: "x" });
  });
});

describe("fetching what the code wrote", () => {
  it("asks the container for the file and keeps its media type", async () => {
    let asked = "";
    const file = await downloadContainerFile(
      { containerId: "cntr_1", fileId: "cfile_9", filename: "revenue.png" },
      "key",
      (async (url: string) => {
        asked = url;
        return new Response(new Uint8Array([137, 80]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }) as unknown as typeof fetch
    );

    expect(asked).toBe("https://api.openai.com/v1/containers/cntr_1/files/cfile_9/content");
    expect(file?.name).toBe("revenue.png");
    expect(file?.mediaType).toBe("image/png");
  });

  /**
   * A fetch that fails must not throw: the reply is already written, and losing
   * one attachment beats losing the whole answer. The caller reports the gap.
   */
  it("returns nothing rather than throwing when the container refuses", async () => {
    const file = await downloadContainerFile(
      { containerId: "c", fileId: "f", filename: "x.pdf" },
      "key",
      (async () => {
        throw new Error("gone");
      }) as unknown as typeof fetch
    );
    expect(file).toBeUndefined();
  });
});
