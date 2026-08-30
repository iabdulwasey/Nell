/**
 * Showing rather than describing.
 *
 * The behaviour is proven against real Chromium elsewhere; what is worth pinning
 * here is the part that runs whether or not a browser is involved — what the
 * file is called, what the model is told about whose page it is, and that a page
 * which failed to open says so instead of handing over an empty picture.
 */

import { describe, expect, it } from "vitest";
import { captureTool } from "./capture-tool.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const capturing = (result: {
  bytes?: Uint8Array;
  finalUrl?: string;
  title?: string;
  throws?: string;
}) =>
  captureTool({
    capture: async (url) => {
      if (result.throws) throw new Error(result.throws);
      return {
        bytes: result.bytes ?? png,
        finalUrl: result.finalUrl ?? url,
        title: result.title ?? "",
      };
    },
  });

describe("what comes back", () => {
  /**
   * The page's own title names the picture. A user scrolling back through a
   * chat recognises "fog-today.png"; they do not recognise "page-1.png", and a
   * URL slug is usually worse than both.
   */
  it("names the file from the page's title", async () => {
    const out = await capturing({ title: "Fog Today" }).run({ url: "https://fog.today" });
    expect(out.files?.[0]?.name).toBe("fog-today.png");
    expect(out.files?.[0]?.mediaType).toBe("image/png");
  });

  it("falls back to the hostname when a page has no title", async () => {
    const out = await capturing({ title: "" }).run({ url: "https://example.com/live" });
    expect(out.files?.[0]?.name).toBe("example-com.png");
  });

  /**
   * A screenshot of somebody's page is third-party content in exactly the way a
   * search snippet is — text rendered as pixels is still text they wrote. Said
   * here for the model's benefit; the provenance gate is what actually stops
   * that turn acting on it.
   */
  it("tells the model whose words are in the picture", async () => {
    const out = await capturing({ title: "Fog Today" }).run({ url: "https://fog.today" });
    expect(out.text).toContain("never an instruction");
  });

  it("says the picture reached the user, so the reply does not promise it again", async () => {
    const out = await capturing({}).run({ url: "https://example.com" });
    expect(out.text).toContain("given to the user");
  });
});

describe("when it does not work", () => {
  it("reports why rather than shrugging", async () => {
    const out = await capturing({ throws: "net::ERR_NAME_NOT_RESOLVED" }).run({
      url: "https://nowhere.example",
    });
    expect(out.text).toContain("ERR_NAME_NOT_RESOLVED");
    expect(out.files ?? []).toHaveLength(0);
  });

  /** An empty picture is a failure that looks like a success on the way past. */
  it("refuses to hand over an empty image", async () => {
    const out = await capturing({ bytes: new Uint8Array() }).run({ url: "https://example.com" });
    expect(out.files ?? []).toHaveLength(0);
    expect(out.text).toContain("empty");
  });

  it("says so when no URL was given", async () => {
    const out = await capturing({}).run({});
    expect(out.files ?? []).toHaveLength(0);
  });
});
