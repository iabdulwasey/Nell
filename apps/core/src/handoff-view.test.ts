/**
 * Handing the controls over, and what the page may ask for.
 *
 * The handoff policy in `@nell/aegis` was complete and careful and reached by
 * nothing — the tenth thing in this repository found built, tested, and never
 * once run. It stayed unreachable for a real reason: the design assumes a cloud
 * browser with a live-view URL, and a local Chromium has none. Meanwhile the
 * agent was telling real users *"if you open it yourself I can carry on"* — a
 * sentence describing a feature nobody could reach.
 *
 * What is tested here is the half that faces the page. A handoff link is a
 * session takeover: whoever opens it drives a browser signed into the user's
 * accounts, so the command parser is a boundary and not a convenience — and a
 * parser that trusts its own client is one that breaks the first time somebody
 * curls it.
 */

import { describe, expect, it } from "vitest";
import { actionFor, handoffPage, readCommand } from "./handoff-view.js";

describe("what the page may ask for", () => {
  it("takes a click at a point", () => {
    expect(readCommand({ do: "click", x: 120, y: 340 })).toEqual({ do: "click", x: 120, y: 340 });
  });

  /** A click at NaN is a bug or an attack; either way the browser must not see it. */
  it("refuses a coordinate that is not a real one", () => {
    for (const bad of [
      { do: "click", x: Number.NaN, y: 1 },
      { do: "click", x: 1, y: Number.POSITIVE_INFINITY },
      { do: "click", x: -5, y: 1 },
      { do: "click", x: "120", y: 340 },
    ]) {
      expect(readCommand(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  /**
   * One keystroke at a time, which is what the page sends. A long string here
   * would be a paste nobody watched being typed into a signed-in browser.
   */
  it("takes a keystroke and refuses a paste", () => {
    expect(readCommand({ do: "type", text: "a" })).toEqual({ do: "type", text: "a" });
    expect(readCommand({ do: "type", text: "x".repeat(200) })).toBeUndefined();
    expect(readCommand({ do: "type", text: "" })).toBeUndefined();
  });

  /** A closed set: the four keys a person needs to clear a wall, and no others. */
  it("takes only the named keys", () => {
    expect(readCommand({ do: "key", key: "Enter" })).toEqual({ do: "key", key: "Enter" });
    expect(readCommand({ do: "key", key: "F12" })).toBeUndefined();
    expect(readCommand({ do: "key", key: "Meta" })).toBeUndefined();
  });

  it("refuses anything it does not recognise", () => {
    for (const bad of [undefined, null, "click", { do: "navigate", url: "https://evil.example" }]) {
      expect(readCommand(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("what reaches the browser", () => {
  /**
   * A plain click. A handoff that could synthesise Ctrl or Meta would be a
   * wider capability than "touch the screen" — which is all that was granted.
   */
  it("sends a click with no modifiers", () => {
    expect(actionFor({ do: "click", x: 10, y: 20 })).toEqual({
      action: "left_click",
      coordinate: { x: 10, y: 20 },
      modifiers: [],
    });
  });

  it("sends typing and named keys in the driver's vocabulary", () => {
    expect(actionFor({ do: "type", text: "q" })).toEqual({ action: "type", text: "q" });
    expect(actionFor({ do: "key", key: "Enter" })).toEqual({ action: "key", keys: ["Enter"] });
  });

  /** `finish` is the caller's to handle — it ends the takeover rather than touching the page. */
  it("has no browser action for finishing", () => {
    expect(actionFor({ do: "finish" })).toBeUndefined();
  });
});

describe("the page itself", () => {
  it("tells the person what they are being asked to do, and where", () => {
    const html = handoffPage("tok", "It wants a person, not a bot.", "bookmyshow.com");
    expect(html).toContain("bookmyshow.com");
    expect(html).toContain("It wants a person, not a bot.");
    expect(html).toContain("I'm done");
  });

  /**
   * The site name arrives from a URL and lands in HTML. Escaped, because a host
   * is attacker-influenced text and this page is served on the machine holding
   * the user's logins.
   */
  it("escapes what it did not write", () => {
    const html = handoffPage("tok", "why", '<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  /** The token goes in the page's own fetches and must survive JSON quoting. */
  it("carries the token to its own endpoints", () => {
    expect(handoffPage("abc123", "why", "site")).toContain('"abc123"');
  });
});
