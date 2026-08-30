/**
 * What gets sent in `tools`, and why it has to be checked.
 *
 * A tool list is the one part of the request built by *combining* things chosen
 * in different places — the vendor's server-side tools, turned on by the caller,
 * and the client tools supplied by whoever wired the process. Nothing checked
 * that the combination was legal.
 *
 * It was not. Searching became a client tool named `web_search` so that every
 * vendor could search; this vendor's own searcher is also called `web_search`;
 * both went into one request; and the API answered `tools: Tool names must be
 * unique.` for **every assist task on the Anthropic path**. Two correct changes,
 * a collision between them, and total failure of the main code path — shipped,
 * because each half was tested alone.
 *
 * So the assertion here is the *invariant* rather than that one pair: whatever
 * combination arrives, every name in the request is distinct. That catches the
 * next server-side tool a vendor ships under a name somebody already used, which
 * is the same bug and will be just as total.
 */

import { describe, expect, it } from "vitest";
import { assist, type ClientTool } from "./assistant.js";

/** Captures the request body without a network call. */
function capturing(): { bodies: Record<string, unknown>[]; fetchImpl: typeof fetch } {
  const bodies: Record<string, unknown>[] = [];

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);

    // One finished turn with no tool calls, so the loop runs exactly once.
    const frames = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ];

    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }) as unknown as typeof fetch;

  return { bodies, fetchImpl };
}

const clientTool = (name: string): ClientTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: "object", properties: {} },
  run: async () => ({ text: "" }),
});

const namesIn = (body: Record<string, unknown>): string[] =>
  ((body["tools"] ?? []) as { name: string }[]).map((tool) => tool.name);

describe("the tools sent to Anthropic", () => {
  it("never sends two tools with the same name", async () => {
    const { bodies, fetchImpl } = capturing();

    await assist({
      apiKey: "k",
      model: "anthropic/claude-sonnet-4-5",
      system: "s",
      prompt: "p",
      search: true,
      code: true,
      // Exactly the wiring that broke it: our own searcher, beside the vendor's.
      tools: [clientTool("web_search"), clientTool("fetch_url"), clientTool("generate_image")],
      fetchImpl,
    });

    const names = namesIn(bodies[0]!);
    expect(new Set(names).size, names.join(", ")).toBe(names.length);
  });

  /**
   * The server one wins, because where it exists it is better: one request, no
   * round trip, no snippets crossing this process. Dropping the *server* tool
   * instead would silently make searching slower and more expensive on the one
   * vendor that does it best.
   */
  it("keeps the vendor's own searcher and drops the client copy", async () => {
    const { bodies, fetchImpl } = capturing();

    await assist({
      apiKey: "k",
      model: "anthropic/claude-sonnet-4-5",
      system: "s",
      prompt: "p",
      search: true,
      tools: [clientTool("web_search")],
      fetchImpl,
    });

    const tools = (bodies[0]!["tools"] ?? []) as { name: string; type?: string }[];
    const search = tools.filter((tool) => tool.name === "web_search");
    expect(search).toHaveLength(1);
    expect(search[0]?.type).toBe("web_search_20250305");
  });

  /** With the vendor's searcher off, ours is the only way to search and must survive. */
  it("keeps the client searcher when the vendor's is not enabled", async () => {
    const { bodies, fetchImpl } = capturing();

    await assist({
      apiKey: "k",
      model: "anthropic/claude-sonnet-4-5",
      system: "s",
      prompt: "p",
      search: false,
      tools: [clientTool("web_search")],
      fetchImpl,
    });

    expect(namesIn(bodies[0]!)).toContain("web_search");
  });

  /**
   * On the chat-completions path there are no server tools at all, so nothing
   * collides and every client tool must arrive — including the searcher, which
   * is the only searching those vendors get.
   */
  it("sends every client tool on the chat-completions path", async () => {
    const { bodies, fetchImpl } = capturing();

    await assist({
      apiKey: "k",
      model: "deepseek/deepseek-chat",
      system: "s",
      prompt: "p",
      search: true,
      tools: [clientTool("web_search"), clientTool("fetch_url")],
      fetchImpl,
    });

    const names = ((bodies[0]!["tools"] ?? []) as { function: { name: string } }[]).map(
      (tool) => tool.function.name
    );
    expect(names).toEqual(["web_search", "fetch_url"]);
    expect(new Set(names).size).toBe(names.length);
  });
});
