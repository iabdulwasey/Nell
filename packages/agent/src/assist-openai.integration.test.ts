/**
 * The whole assist loop, over a socket, against a real chat-completions endpoint.
 *
 * The unit tests cover the translation in both directions. They cannot catch the
 * thing that actually breaks a transport: a request shape the far end rejects, a
 * stream framed differently than expected, or a second turn that does not carry
 * the first turn's tool call correctly — the last of which produces no error at
 * all, just a model asking for the same thing twice.
 *
 * So this stands up a server that speaks the format, and drives the real
 * `assist` against it. Nothing is stubbed inside the code under test: it opens a
 * connection, sends what it would send OpenAI, reads SSE frames off the wire,
 * runs a client tool, and comes back for a second turn.
 *
 * A vendor key would prove no more than this and cannot run in CI.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assist, type ClientTool } from "./assistant.js";

/** Frames one SSE event the way the endpoint does. */
const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** What each request to the fake endpoint received, so the shape can be asserted. */
const seen: Record<string, unknown>[] = [];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      seen.push(parsed);

      const messages = parsed["messages"] as { role: string }[];
      const answered = messages.some((message) => message.role === "tool");

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      if (!answered) {
        /**
         * First turn: ask for a tool, with the arguments split across frames —
         * which is how they genuinely arrive, and the case a naive
         * implementation gets wrong by parsing each fragment.
         */
        response.write(frame({ choices: [{ delta: { content: "Let me look that up. " } }] }));
        response.write(
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup" } }],
                },
              },
            ],
          })
        );
        response.write(
          frame({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"of":"Rey' } }] } },
            ],
          })
        );
        response.write(
          frame({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'kjavik"}' } }] } },
            ],
          })
        );
        response.write(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
      } else {
        // Second turn: the tool result came back, so answer using it.
        const result = messages.find((message) => message.role === "tool") as
          | { content: string }
          | undefined;
        response.write(
          frame({ choices: [{ delta: { content: `The answer is ${result?.content ?? "?"}.` } }] })
        );
        response.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      }

      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

const lookup: ClientTool = {
  name: "lookup",
  description: "Look something up.",
  inputSchema: { type: "object", properties: { of: { type: "string" } } },
  run: async (input) => ({ text: `249228 for ${String((input as { of: string }).of)}` }),
};

describe("assist against a chat-completions endpoint", () => {
  it("runs the full loop: call a tool, answer with its result", async () => {
    const steps: string[] = [];

    const outcome = await assist({
      apiKey: "test-key",
      model: "openai/gpt-5.6",
      baseUrl,
      system: "Be useful.",
      prompt: "What is the population of Reykjavik?",
      tools: [lookup],
      onStep: (note) => steps.push(note),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The tool's result reached the second turn and was used in the answer.
    expect(outcome.text).toContain("249228");
    expect(steps).toContain("Using lookup.");
  });

  it("sent a request the far end could accept", () => {
    const first = seen[0]!;
    expect(first["model"]).toBe("gpt-5.6");
    expect(first["stream"]).toBe(true);

    // System prompt first, and carrying the date stamp every transport owes.
    const messages = first["messages"] as { role: string; content: string }[];
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toMatch(/\d{4}/u);

    // Our tool, described in this format's shape.
    const tools = first["tools"] as { type: string; function: { name: string } }[];
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function.name).toBe("lookup");
  });

  /**
   * The silent one. The second turn must carry the assistant's tool call *and* a
   * `tool` message naming it. Miss either and the far end has no idea what was
   * answered — no error, just a model asking again.
   */
  it("echoed the call and answered it by id on the second turn", () => {
    const second = seen[1]!;
    const messages = second["messages"] as {
      role: string;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
    }[];

    const assistantTurn = messages.find((message) => message.role === "assistant");
    expect(assistantTurn?.tool_calls?.[0]?.id).toBe("call_1");

    const toolTurn = messages.find((message) => message.role === "tool");
    expect(toolTurn?.tool_call_id).toBe("call_1");
  });
});
