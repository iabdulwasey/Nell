/**
 * The Responses transport, over a socket, end to end.
 *
 * No OpenAI key exists on this machine, so the alternative to this is a
 * transport whose fixtures pass and which has **never made a request**. That is
 * the exact shape this repository keeps finding and paying for, so the gap is
 * closed as far as it can be without a vendor account: a real server speaking
 * the protocol, and the real `assist` driven at it over a real connection.
 *
 * What only this can catch: a request body the endpoint would reject, a stream
 * framed differently than expected, and — the one that matters most here — the
 * **file citation path**. The container hands back a citation, not bytes; a
 * transport that stopped there would return a confident answer naming a file
 * nobody receives, which this codebase has already shipped once.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assist, type ClientTool } from "./assistant.js";

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** Every request body the fake endpoint received, so the shape can be asserted. */
const seen: Record<string, unknown>[] = [];

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    // The container's file download, which is a plain GET rather than a stream.
    if (request.url?.includes("/containers/")) {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(Buffer.from("%PDF-1.4 fake"));
      return;
    }

    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      seen.push(parsed);

      const input = parsed["input"] as { type?: string }[];
      const answered = input.some((item) => item.type === "function_call_output");

      response.writeHead(200, { "content-type": "text/event-stream" });

      if (!answered) {
        // A tool call, so the loop has to come back for a second turn.
        response.write(frame({ type: "response.output_text.delta", delta: "Let me look. " }));
        response.write(
          frame({
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                { type: "function_call", call_id: "fc_1", name: "lookup", arguments: '{"of":"x"}' },
              ],
            },
          })
        );
      } else {
        // The second turn answers, and cites a file the container wrote.
        response.write(frame({ type: "response.output_text.delta", delta: "Done." }));
        response.write(
          frame({
            type: "response.completed",
            response: {
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: "I made report.pdf from the lookup.",
                      annotations: [
                        {
                          type: "container_file_citation",
                          container_id: "cntr_1",
                          file_id: "cfile_1",
                          filename: "report.pdf",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          })
        );
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
  origin = `http://127.0.0.1:${String(address.port)}`;
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
  run: async () => ({ text: "the value is 42" }),
};

/**
 * Points the transport's two absolute URLs at the local server.
 *
 * The endpoint and the container download are both hard-coded to
 * api.openai.com — correctly, since this transport is OpenAI's own — so the test
 * redirects at the fetch rather than by adding a base-URL knob that production
 * would never use.
 */
const toLocalServer = (async (url: string | URL, init?: RequestInit) =>
  fetch(String(url).replace("https://api.openai.com", origin), init)) as unknown as typeof fetch;

describe("assist against a Responses endpoint", () => {
  it("runs the loop and hands over the file the container wrote", async () => {
    const outcome = await assist({
      apiKey: "test-key",
      model: "openai/gpt-5.6",
      system: "Be useful.",
      prompt: "Make me a report.",
      code: true,
      tools: [lookup],
      fetchImpl: toLocalServer,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.text).toContain("report.pdf");

    /**
     * The assertion the whole transport exists for. The reply *cited* a file;
     * the bytes were a second call. Without it this returns a confident answer
     * naming a document nobody receives.
     */
    expect(outcome.files).toHaveLength(1);
    expect(outcome.files[0]?.name).toBe("report.pdf");
    expect(outcome.files[0]?.mediaType).toBe("application/pdf");
    expect(new TextDecoder().decode(outcome.files[0]?.data)).toContain("%PDF");
  });

  it("sent a body the endpoint could accept", () => {
    const first = seen[0]!;
    expect(first["model"]).toBe("gpt-5.6");
    expect(first["stream"]).toBe(true);
    // `instructions`, not a system message: this endpoint keeps them apart.
    expect(String(first["instructions"])).toMatch(/\d{4}/u);

    const tools = first["tools"] as { type: string; name?: string }[];
    expect(tools.some((tool) => tool.type === "code_interpreter")).toBe(true);
    // Flat, not nested under `function` — the other format from the same vendor.
    expect(tools.find((tool) => tool.type === "function")?.name).toBe("lookup");
  });

  /**
   * The silent failure. A result that does not name the call it answers is
   * dropped by the far end, and the model asks for the same thing again with
   * nothing in the logs to say why.
   */
  it("answered the tool call by id on the second turn", () => {
    const second = seen[1]!;
    const input = second["input"] as { type?: string; call_id?: string; output?: string }[];

    const call = input.find((item) => item.type === "function_call");
    expect(call?.call_id).toBe("fc_1");

    const result = input.find((item) => item.type === "function_call_output");
    expect(result?.call_id).toBe("fc_1");
    expect(result?.output).toBe("the value is 42");
  });
});
