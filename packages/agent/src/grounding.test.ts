/**
 * Every model call knows what day it is.
 *
 * This was fixed once, in the planner, and stayed fixed only there. The
 * dispatcher went without it until the first follow-up it was asked to resolve
 * turned "3 September" into "3 September 2025" — its training cutoff, written
 * in confidently while being told to invent nothing. Vision never had it at all.
 *
 * The failure mode is what makes it worth a test rather than a convention:
 * nothing errors. A search runs, results come back, and they are for a year
 * nobody asked about. So the guarantee moved to the transport, and this is the
 * test that says so — including for adapters nobody has written yet, since the
 * one below is invented here and is grounded anyway.
 */

import { describe, expect, it } from "vitest";
import { anthropicProvider, grounded, openAiCompatibleProvider, stampToday } from "./provider.js";
import type { ModelProvider } from "./provider.js";

const DAY = new Date("2026-08-30T09:00:00.000Z");

/** Captures whatever system prompt it is handed. */
function spy(): { provider: ModelProvider; seen: () => string } {
  let system = "";
  return {
    provider: {
      name: "spy",
      complete: (request) => {
        system = request.system;
        return Promise.resolve({
          ok: true as const,
          value: {},
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      },
    },
    seen: () => system,
  };
}

const ask = (provider: ModelProvider) =>
  provider.complete({ model: "x/y", system: "Drive the browser.", messages: [], schema: {} });

describe("stamping the date", () => {
  it("puts it first, so a prompt cache is invalidated daily rather than per call", () => {
    const stamped = stampToday("Drive the browser.", DAY);
    expect(stamped.startsWith("Today is Sun Aug 30 2026.")).toBe(true);
    expect(stamped).toContain("Drive the browser.");
  });

  it("carries through the wrapper to whatever the provider sends", async () => {
    const target = spy();
    await ask(grounded(target.provider, () => DAY));
    expect(target.seen()).toContain("Sun Aug 30 2026");
  });

  /**
   * The point of wrapping inside each adapter rather than at `providerFor`: a
   * provider built by any route is grounded, including one built directly.
   */
  it("holds for a provider constructed directly, not only through the factory", async () => {
    for (const [label, provider] of [
      ["anthropic", anthropicProvider("k", stubFetch())],
      [
        "openai-compatible",
        openAiCompatibleProvider("openai", "https://x.test/v1", "k", stubFetch()),
      ],
    ] as const) {
      const sent = await capture(provider);
      expect(sent, label).toMatch(/^Today is \w{3} \w{3} \d{1,2} \d{4}\./u);
    }
  });

  /**
   * An adapter written next year gets the guarantee only if it is wrapped. This
   * asserts the wrapper is what supplies it, so the rule is a property of
   * `grounded` and not of the two adapters that happen to exist today.
   */
  it("is supplied by the wrapper, not by any particular adapter", async () => {
    const bare = spy();
    await ask(bare.provider);
    expect(bare.seen()).not.toContain("Today is");

    const wrapped = spy();
    await ask(grounded(wrapped.provider, () => DAY));
    expect(wrapped.seen()).toContain("Today is");
  });

  it("keeps the provider's own name, so routing and errors are unchanged", () => {
    expect(grounded({ name: "kimi", complete: () => Promise.reject(new Error("x")) }).name).toBe(
      "kimi"
    );
  });
});

/** A fetch that records the request body and returns something parseable. */
function stubFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    sent = String(init?.body ?? "");
    return Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: "tool_use", input: {} }],
          choices: [{ message: { tool_calls: [{ function: { arguments: "{}" } }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  }) as unknown as typeof fetch;
}

let sent = "";

async function capture(provider: ModelProvider): Promise<string> {
  sent = "";
  await ask(provider);
  const body = JSON.parse(sent) as {
    system?: string;
    messages?: { role: string; content: string }[];
  };
  // Anthropic carries it in `system`; the OpenAI shape puts it in a system message.
  return body.system ?? body.messages?.find((message) => message.role === "system")?.content ?? "";
}
