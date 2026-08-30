/**
 * What the model may fetch, and — mostly — what it may not.
 *
 * `fetch_url` is the only tool where the model picks the destination, which
 * makes it the only one that can be turned into a request forger: a page says
 * "see http://169.254.169.254/…" and an obliging model asks *our own host* for
 * it.
 *
 * **Hosted, this is the difference between an embarrassment and a breach.** On a
 * laptop the worst reachable thing is the vault form on loopback — one person's.
 * On a server that address is the cloud metadata endpoint handing out instance
 * credentials, and one tenant's model following a suggestion from a web page
 * would compromise every tenant. Same code, different blast radius.
 *
 * Every case below was written before the fix that made it pass, and two of them
 * failed: IPv6 literals went straight through, because `URL.hostname` keeps the
 * brackets so `isIP` said "not an address"; and `::ffff:127.0.0.1` went through
 * because the URL parser canonicalises it to `::ffff:7f00:1`, which the
 * dotted-quad check did not recognise.
 */

import { describe, expect, it } from "vitest";
import { checkUrl } from "./fetch-url.js";

/** A resolver that answers however the case needs, so no test touches DNS. */
const resolving =
  (answers: Record<string, readonly string[]> = {}) =>
  (host: string): Promise<readonly string[]> =>
    Promise.resolve(answers[host] ?? ["93.184.216.34"]);

const refuses = async (url: string, answers?: Record<string, readonly string[]>) =>
  (await checkUrl(url, resolving(answers))).ok;

describe("addresses that are not the public internet", () => {
  it("refuses the cloud metadata endpoint, by address and by name", async () => {
    expect(await refuses("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(
      await refuses("http://metadata.google.internal/computeMetadata/v1/", {
        "metadata.google.internal": ["169.254.169.254"],
      })
    ).toBe(false);
  });

  it("refuses our own host and our own network", async () => {
    for (const url of [
      "http://127.0.0.1:7431/v/token",
      "http://localhost:3000/",
      "http://10.0.3.17:5432/",
      "http://192.168.1.10/",
      "http://172.20.0.4/",
      "http://100.64.0.1/",
    ]) {
      expect(await refuses(url, { localhost: ["127.0.0.1"] }), url).toBe(false);
    }
  });

  /**
   * The two that were actually broken.
   *
   * `URL.hostname` returns `"[::1]"` *with brackets*, so the literal-address
   * check missed it entirely and fell through to resolving that string as a
   * hostname.
   */
  it("refuses IPv6 private space, brackets and all", async () => {
    for (const url of ["http://[::1]:7431/", "http://[fd00::1]/", "http://[fe80::1]/"]) {
      expect(await refuses(url), url).toBe(false);
    }
  });

  /**
   * And the sharper one: the URL parser rewrites `::ffff:127.0.0.1` as
   * `::ffff:7f00:1`, so a check that knew only the dotted spelling passed
   * loopback through in hex.
   */
  it("refuses a v4 address mapped into v6, in either spelling", async () => {
    expect(await refuses("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(await refuses("http://[::ffff:10.0.0.5]/")).toBe(false);
  });

  it("refuses anything that is not http or https", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/"]) {
      expect(await refuses(url), url).toBe(false);
    }
  });
});

describe("names that resolve somewhere they should not", () => {
  /**
   * The attack that a hostname check alone cannot see: an ordinary-looking
   * domain whose record points inward.
   */
  it("refuses a public name with a private answer", async () => {
    expect(await refuses("https://evil.example/x.png", { "evil.example": ["127.0.0.1"] })).toBe(
      false
    );
  });

  /**
   * Every address, not merely the first. A host answering with one public and
   * one private address reaches the private one whenever the resolver feels
   * like it, and a check that looked at `[0]` would pass it half the time.
   */
  it("refuses when any one of several answers is private", async () => {
    expect(
      await refuses("https://mixed.example/x.png", {
        "mixed.example": ["93.184.216.34", "10.1.2.3"],
      })
    ).toBe(false);
  });

  it("refuses a host with no address at all", async () => {
    expect(await refuses("https://nowhere.example/", { "nowhere.example": [] })).toBe(false);
  });
});

describe("what it is for", () => {
  it("allows an ordinary public file", async () => {
    const verdict = await checkUrl("https://upload.wikimedia.org/monkey.jpg", resolving());
    expect(verdict.ok).toBe(true);
  });

  it("allows a public address written as a literal", async () => {
    expect(await refuses("http://[::ffff:8.8.8.8]/")).toBe(true);
    expect(await refuses("http://93.184.216.34/x.png")).toBe(true);
  });
});
