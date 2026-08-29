/**
 * A real search vendor behind the `SearchProvider` port.
 *
 * Built because of a failure watched live: asked for today's AI news, the agent
 * went to Google and got a captcha, went to DuckDuckGo and got a captcha, and
 * spent the whole task never reaching a page with news on it. A headless browser
 * asking a search engine for results looks exactly like what search engines
 * exist to block, and no amount of prompting fixes that — it is not a reasoning
 * failure.
 *
 * What matters is which half of the job this replaces. Search engines block
 * automated browsers; ordinary sites mostly do not. So the browser is not the
 * problem, the *search step* is — and this removes it from the browser entirely.
 * The agent gets real URLs from an API and navigates straight to them, which is
 * both the way past the gate and, per the architecture, the cheaper path: a
 * search costs a fraction of loading a results page and snapshotting it.
 *
 * **What this provider cannot give, and why that is stated rather than hidden.**
 * Anthropic returns each result's title, URL and age, with the page content
 * *encrypted* — readable only by passing it back to Anthropic, never by us. So
 * `snippet` here carries no page text, and this provider is a way to find pages
 * rather than a way to read them. A vendor with plaintext snippets (Brave,
 * Tavily) drops into the same port and fills that field properly; the agent
 * works either way because it browses what it finds.
 *
 * Nothing about model choice is implied. This is a search vendor that happens to
 * be reachable with an Anthropic key, in the same way Brave is a search vendor
 * reachable with a Brave key — a workspace driving its agent with DeepSeek or a
 * local model can still search through this, and a workspace using Claude can
 * search through Brave.
 */

import { z } from "zod";
import type { SearchProvider, SearchQuery, SearchResult } from "./search.js";

const RESULT_BLOCK = "web_search_result";

/**
 * Only the fields we use, and `url` validated rather than trusted: the whole
 * point of the result is that the agent is about to navigate to it.
 */
const resultSchema = z.object({
  type: z.literal(RESULT_BLOCK),
  title: z.string().default(""),
  url: z.string(),
  /** Relative, as the API reports it — "3 days ago". */
  page_age: z.string().nullish(),
});

const responseSchema = z.object({
  content: z
    .array(
      z.object({
        type: z.string(),
        content: z.unknown().optional(),
      })
    )
    .default([]),
});

export interface AnthropicSearchOptions {
  readonly apiKey: string;
  /**
   * The model that performs the search. A small one is correct: it is issuing a
   * query, not reasoning about the answer — that happens later, in the planner,
   * under whichever model the workspace chose.
   */
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export const DEFAULT_SEARCH_MODEL = "claude-haiku-4-5-20251001";

export function anthropicSearchProvider(options: AnthropicSearchOptions): SearchProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_SEARCH_MODEL;

  return {
    name: "anthropic-web-search",

    async search(query: SearchQuery): Promise<readonly SearchResult[]> {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);

      const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 1,
              // The vendor enforces this; the caller's `site` is a request, not
              // a filter we then have to trust the results to respect.
              ...(query.site ? { allowed_domains: [query.site] } : {}),
            },
          ],
          // Terse on purpose. Prose back from this call is waste — the results
          // are the product, and the answer is the planner's job.
          messages: [
            {
              role: "user",
              content: `Search the web for: ${query.query}\n\nSearch once. Do not summarise.`,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Search provider returned ${String(response.status)}.`);
      }

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Search provider returned an unexpected shape.");

      const limit = query.maxResults ?? 8;
      const out: SearchResult[] = [];

      for (const block of parsed.data.content) {
        if (!Array.isArray(block.content)) continue;
        for (const entry of block.content) {
          const result = resultSchema.safeParse(entry);
          if (!result.success) continue;
          out.push({
            title: result.data.title,
            url: result.data.url,
            // Deliberately not a summary. `searchWeb` validates and the planner
            // reads this; inventing a description of a page nobody has read
            // would be the one failure mode worse than having no description.
            snippet: "",
            ...(result.data.page_age ? { publishedAt: result.data.page_age } : {}),
          });
          if (out.length >= limit) return out;
        }
      }

      return out;
    },
  };
}
