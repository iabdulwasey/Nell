import { describe, expect, it } from "vitest";
import { detectBlock, explainBlock } from "./blocked.js";
import type { PageSnapshot } from "./perception.js";

function page(title: string, text: string, url = "https://in.bookmyshow.com/x"): PageSnapshot {
  return { url, title, text, nodes: [], truncated: false };
}

describe("recognising a wall", () => {
  /** The exact page that ate a whole task, copied from the snapshot it produced. */
  it("recognises the Cloudflare block that was misread as an access warning", () => {
    const verdict = detectBlock(
      page(
        "Attention Required! | Cloudflare",
        "Sorry, you have been blocked\nYou are unable to access bookmyshow.com\n" +
          "Why have I been blocked?\nThis website is using a security service to protect itself " +
          "from online attacks."
      )
    );

    expect(verdict.blocked).toBe(true);
    expect(verdict.kind).toBe("blocked");
  });

  it("tells a challenge apart from a refusal", () => {
    // A person can pass this one, which is the whole reason it is a separate kind.
    expect(
      detectBlock(page("Just a moment...", "Checking your browser before accessing the site.")).kind
    ).toBe("challenge");

    expect(
      detectBlock(
        page("Search", "Our systems have detected unusual traffic from your computer network.")
      ).kind
    ).toBe("challenge");

    expect(detectBlock(page("Access Denied", "You are unable to access this site.")).kind).toBe(
      "blocked"
    );
  });

  /**
   * A false positive abandons a task that could have succeeded, so the cost of
   * being loose here is higher than the cost of missing one. These are all pages
   * that talk *about* the subject rather than being an instance of it.
   */
  it("leaves ordinary pages alone", () => {
    for (const [title, text] of [
      ["Showtimes", "Spider-Man — 9:15 PM, 10:30 PM. Book now."],
      ["Login", "Access denied? Reset your password below."],
      ["Blog", "How captchas work, and why bot detection is an arms race."],
      ["Support", "If you are blocked from your account, contact support."],
      ["Robots", "Verify your identity to continue to your dashboard."],
      ["News", "Cloudflare reported a rise in automated traffic this quarter."],
    ] as const) {
      expect(detectBlock(page(title, text)).blocked, `${title}: ${text}`).toBe(false);
    }
  });

  /**
   * A block page is short. The same phrase deep inside a long article is a page
   * about the subject — reading the whole body would flag every write-up of the
   * very failure this exists to catch.
   */
  it("does not flag the phrase buried in a long article", () => {
    const article = `${"Bot detection has a long history. ".repeat(120)}you have been blocked`;
    expect(detectBlock(page("A history of bot detection", article)).blocked).toBe(false);
  });

  it("names the site and says what it means", () => {
    const blocked = explainBlock({ blocked: true, kind: "blocked" }, "https://www.fandango.com/x");
    expect(blocked).toContain("fandango.com");
    expect(blocked).not.toContain("Cloudflare");

    const challenge = explainBlock({ blocked: true, kind: "challenge" }, "https://google.com/s");
    expect(challenge).toContain("google.com");
    // A challenge is something a person could pass, so the offer follows from it.
    expect(challenge.toLowerCase()).toContain("open it yourself");
  });

  /** The real page, copied from the snapshot it produced. */
  it("tells a network filter apart from the site refusing", () => {
    const verdict = detectBlock(
      page(
        "Access Notification",
        "Blocked Access to Website\nWarning - Restricted Website\n\n" +
          "Access to this web page is not allowed by your organization's policy\n\nPROCEED",
        "https://www.fandango.com/"
      )
    );

    expect(verdict.blocked).toBe(true);
    expect(verdict.kind).toBe("network-policy");

    const said = explainBlock(verdict, "https://www.fandango.com/");
    expect(said).toContain("fandango.com");
    expect(said).toContain("network");
    expect(said).toContain("not the site itself");
  });

  it("handles a snapshot with no text at all", () => {
    expect(
      detectBlock({ url: "https://x.com", title: "x", nodes: [], truncated: false }).blocked
    ).toBe(false);
  });

  it("survives a url it cannot parse", () => {
    expect(explainBlock({ blocked: true, kind: "blocked" }, "not a url")).toContain("That site");
  });
});
