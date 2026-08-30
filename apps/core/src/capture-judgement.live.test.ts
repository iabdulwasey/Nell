/**
 * Does Nell know when to show you the page?
 *
 * The only thing telling the model when to reach for a tool is that tool's
 * description, and this repository has already been bitten once by getting one
 * wrong: `generate_image` said "use this whenever an image is wanted", which
 * claims the territory of *downloading* one too, so asked to find a photograph
 * of a monkey the model drew a monkey. The failure looked like bad reasoning and
 * was a badly written sentence.
 *
 * So a description is not something to write and assume. This measures it.
 *
 * The first version was scored 4 out of 5, and the miss was the case that
 * prompted the whole feature: *"given today's fog, where should I photograph
 * Sutro Tower"* searched and never showed the map — while *"is there rain over
 * London right now, show me"* screenshotted immediately. The word **show** was
 * doing the work, so the tool was reachable only by someone who already knew to
 * ask for it. Rewriting the trigger around what the answer *rests on* rather
 * than what was requested took it to 6 of 6.
 *
 * The negative cases matter as much as the positive ones and are the reason this
 * is not simply "make it fire more". A tool that fires on everything is the same
 * bug in the other direction: a screenshot of an article is worse than quoting
 * it, and a screenshot of an arithmetic answer is nothing at all.
 *
 * Costs money and depends on a third party, so it is not in `pnpm check`. Run it
 * with `pnpm --filter @nell/core-app test:live`.
 */

import { describe, expect, it } from "vitest";
import { assist, captureTool, checkUrl, fetchTool, searchTool } from "@nell/agent";
import { LocalMachineHost } from "@nell/browser/adapters";
import { anthropicSearchProvider } from "@nell/integrations";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apiKey = process.env["ANTHROPIC_API_KEY"];
const describeLive = apiKey ? describe : describe.skip;

/** Whether a picture came back, which is the only thing being scored. */
async function showsAPicture(prompt: string): Promise<{ shown: boolean; tools: string[] }> {
  const provider = anthropicSearchProvider({ apiKey: apiKey! });
  const host = new LocalMachineHost({
    root: mkdtempSync(join(tmpdir(), "nell-capture-")),
    headless: true,
  });

  const tools: string[] = [];
  const outcome = await assist({
    apiKey: apiKey!,
    model: "anthropic/claude-sonnet-4-5",
    system: "Do the job properly. Commit to an answer. Do not pad.",
    prompt,
    search: true,
    code: true,
    tools: [
      searchTool({ search: (query) => provider.search(query) }),
      fetchTool(),
      captureTool({
        capture: async (url, options) => {
          const machine = await host.provision("judgement", { scratch: true });
          try {
            return await host.capture(machine.id, url, {
              allow: async (candidate) => (await checkUrl(candidate)).ok,
              ...(options?.fullPage === true ? { fullPage: true } : {}),
            });
          } finally {
            await host.destroy(machine.id).catch(() => undefined);
          }
        },
      }),
    ],
    onStep: (note) => {
      const used = /^Using (.+)\.$/u.exec(note);
      if (used?.[1]) tools.push(used[1]);
    },
  });

  return {
    shown: outcome.ok && outcome.files.some((file) => file.mediaType === "image/png"),
    tools,
  };
}

describeLive("when to show the page rather than describe it", () => {
  /**
   * The case this feature exists for, and the one the first description missed.
   * The whole answer hinges on what the fog is doing; a map settles in a glance
   * what a paragraph can only assert.
   */
  it("shows the map when the answer rests on a live condition", async () => {
    const { shown, tools } = await showsAPicture(
      "Given today's fog in SF, where should I stand to photograph Sutro Tower at 5pm?"
    );
    expect(shown, tools.join(" → ")).toBe(true);
  }, 300_000);

  it("shows the map when asked about weather happening right now", async () => {
    const { shown, tools } = await showsAPicture("Is there heavy rain over London right now?");
    expect(shown, tools.join(" → ")).toBe(true);
  }, 300_000);

  /**
   * The negatives, which are what stop this becoming the `generate_image`
   * mistake in reverse. A tool that fires on everything has no judgement, and
   * "it screenshots more" is not an improvement.
   */
  it("does not screenshot an arithmetic answer", async () => {
    const { shown, tools } = await showsAPicture(
      "What is 15% of 847, and what's that in euros at 1.08?"
    );
    expect(shown, tools.join(" → ")).toBe(false);
  }, 300_000);

  it("does not screenshot something it simply knows", async () => {
    const { shown, tools } = await showsAPicture("Summarise the plot of Dune in three sentences.");
    expect(shown, tools.join(" → ")).toBe(false);
  }, 300_000);

  /** A screenshot of an article is worse than quoting it — that is what fetch_url is for. */
  it("reads an article rather than photographing it", async () => {
    const { shown, tools } = await showsAPicture(
      "What did the latest Anthropic blog post say about Claude?"
    );
    expect(shown, tools.join(" → ")).toBe(false);
  }, 300_000);
});
