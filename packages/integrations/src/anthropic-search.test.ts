/**
 * The adapter, against a fake transport.
 *
 * The live call is proven elsewhere; what needs testing here is the parsing,
 * because a search vendor's response shape is not our contract and the
 * interesting cases are all about what happens when it does not match.
 */

import { describe, expect, it } from "vitest";
import { anthropicSearchProvider } from "./anthropic-search.js";
import { searchWeb } from "./search.js";

function respond(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

/** The shape the API actually returns, as observed. */
const REAL_SHAPE = {
  content: [
    { type: "server_tool_use", name: "web_search" },
    {
      type: "web_search_tool_result",
      content: [
        {
          type: "web_search_result",
          title: "AI News Today",
          url: "https://example.com/ai-news",
          encrypted_content: "EtQHCioIExgCIiRk…",
          page_age: "3 days ago",
        },
        {
          type: "web_search_result",
          title: "Second",
          url: "https://example.org/second",
          encrypted_content: "abc",
          page_age: null,
        },
      ],
    },
    { type: "text", text: "Here is a summary nobody asked for." },
  ],
};

describe("the Anthropic search adapter", () => {
  it("returns the pages it found, with their dates", async () => {
    const provider = anthropicSearchProvider({ apiKey: "k", fetchImpl: respond(REAL_SHAPE) });
    const results = await provider.search({ query: "ai news" });

    expect(results).toHaveLength(2);
    expect(results[0]?.url).toBe("https://example.com/ai-news");
    expect(results[0]?.publishedAt).toBe("3 days ago");
    // A missing date is absent, not the string "null".
    expect(results[1]?.publishedAt).toBeUndefined();
  });

  /**
   * The vendor returns page content encrypted — readable only by passing it back
   * to Anthropic. So there is no snippet to give, and the honest thing is an
   * empty one. Synthesising a description of a page nobody has read would be
   * worse than having none: the planner would act on it.
   */
  it("does not invent snippets for pages it cannot read", async () => {
    const provider = anthropicSearchProvider({ apiKey: "k", fetchImpl: respond(REAL_SHAPE) });
    const results = await provider.search({ query: "ai news" });

    for (const result of results) expect(result.snippet).toBe("");
  });

  it("respects the result limit", async () => {
    const provider = anthropicSearchProvider({ apiKey: "k", fetchImpl: respond(REAL_SHAPE) });
    expect(await provider.search({ query: "x", maxResults: 1 })).toHaveLength(1);
  });

  it("ignores blocks that are not search results", async () => {
    const provider = anthropicSearchProvider({
      apiKey: "k",
      fetchImpl: respond({
        content: [
          { type: "text", text: "no tool was used" },
          { type: "web_search_tool_result", content: [{ type: "web_search_tool_error" }] },
        ],
      }),
    });
    expect(await provider.search({ query: "x" })).toHaveLength(0);
  });

  it("throws on a failed request rather than reporting no results", async () => {
    const provider = anthropicSearchProvider({ apiKey: "k", fetchImpl: respond({}, 429) });
    await expect(provider.search({ query: "x" })).rejects.toThrow("429");
  });

  /**
   * The two failures look identical to a caller that only sees an empty array,
   * and they call for different responses: "nothing matched" is an answer,
   * "we were rate-limited" is a retry. `searchWeb` turns the throw into an
   * outcome so a vendor being down does not end a task three steps from done.
   */
  it("surfaces vendor failure as a findings outcome, not an exception", async () => {
    const provider = anthropicSearchProvider({ apiKey: "k", fetchImpl: respond({}, 500) });
    const findings = await searchWeb({ query: "x" }, { provider });

    expect(findings.ok).toBe(false);
    expect(findings.error).toContain("500");
    // Still untrusted, even when it failed — there is no path that sets it otherwise.
    expect(findings.provenance).toBe("untrusted");
  });

  it("sends the query and asks the vendor to restrict by site", async () => {
    let body: Record<string, unknown> = {};
    const provider = anthropicSearchProvider({
      apiKey: "k",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ content: [] }), { status: 200 });
      },
    });

    await provider.search({ query: "refund policy", site: "example.com" });

    const tools = body.tools as { allowed_domains?: string[] }[];
    expect(tools[0]?.allowed_domains).toEqual(["example.com"]);
    expect(JSON.stringify(body)).toContain("refund policy");
  });
});
