/**
 * The rule: the user gets a sentence, the log gets the detail.
 *
 * Written after a real reply read `That step did not work on the page:
 * locator.click: Timeout 30000ms exceeded.` — which is not information to
 * someone who asked for cinema times, is not actionable, and reads as the
 * assistant being broken rather than the page being awkward.
 */

import { describe, expect, it } from "vitest";
import { alreadyReadable, humanise } from "./failure.js";

/** Anything a user could mistake for a bug report rather than an answer. */
const LOOKS_TECHNICAL =
  /locator\.|Timeout \d+ms|net::|ERR_|Error:|at .*\(|undefined|null|\{|\}|https?:\/\/api\./u;

describe("what the user is told", () => {
  it("never repeats the vendor's words", () => {
    for (const error of [
      new Error("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator"),
      new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.example/"),
      new Error("Target page, context or browser has been closed"),
      new Error('429 {"type":"error","error":{"message":"rate_limit_error"}}'),
      new Error("Something nobody has ever classified: 0x8007000E"),
      "a bare string thrown from somewhere",
      { weird: true },
    ]) {
      const { message } = humanise(error);
      expect(message, JSON.stringify(error)).not.toMatch(LOOKS_TECHNICAL);
      // And it is a sentence, not a fragment.
      expect(message.length).toBeGreaterThan(20);
      expect(message.trim().endsWith(".") || message.trim().endsWith("?")).toBe(true);
    }
  });

  /** The exact message the user reported. */
  it("turns the timeout that started this into something worth reading", () => {
    const { message, detail } = humanise(
      new Error("locator.click: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('x')")
    );

    expect(message).toContain("didn't respond");
    // And it offers a next move, because "it didn't work" leaves someone holding
    // a phone with nothing to do.
    expect(message.toLowerCase()).toContain("try");

    // The vendor's words survive — for the log, which is where they belong.
    expect(detail).toContain("Timeout 30000ms");
  });

  /**
   * A navigation race is not a broken task — it is a page still moving. It
   * reached a user as "That didn't work and I couldn't tell why", which is the
   * generic line, because nothing classified it.
   */
  it("describes a page that moved as a page that moved", () => {
    const { message } = humanise(
      new Error(
        "page.evaluate: Execution context was destroyed, most likely because of a navigation"
      )
    );
    expect(message).toContain("kept moving");
    expect(message).not.toContain("couldn't tell why");
  });

  it("distinguishes the failures that call for different responses", () => {
    expect(humanise(new Error("net::ERR_CONNECTION_REFUSED")).message).toContain("couldn't reach");
    expect(humanise(new Error("Browser session not found.")).message).toContain("browser closed");
    expect(humanise(new Error("429 rate_limit_error")).message).toContain("busy");
  });

  /**
   * A key problem is not a task failure and must not be described as one — the
   * user cannot fix it by rephrasing, and telling them to try again wastes their
   * time on something that will fail identically.
   */
  it("says plainly when the problem is not the user's to solve", () => {
    for (const error of [new Error("401 invalid x-api-key"), new Error("insufficient credit")]) {
      expect(humanise(error).message).toContain("Abdul");
    }
  });

  /**
   * Policy refusals, block pages and step limits are already written for a
   * person. Passing them through the classifier would replace a specific true
   * statement with a vague one.
   */
  it("leaves a sentence a human already wrote alone", () => {
    const written = "fandango.com is blocked by the network this computer is on.";
    expect(alreadyReadable(written).message).toBe(written);
  });
});

/**
 * A permanent failure told as a temporary one.
 *
 * The generic line ends "ask me again and I'll have another go", which is right
 * for a page that timed out and wrong for a request the vendor refuses to parse.
 * Watched live: the user was told to ask again, did, and got the identical
 * failure — because nothing about asking again could change the shape of the
 * request. Spending someone's time on our bug is worse than admitting ignorance.
 */
describe("a request the vendor could not parse", () => {
  it("says it is ours and that retrying will not help", () => {
    const said = humanise(
      new Error("400 from the model: tools: Tool names must be unique.")
    ).message;

    expect(said).toContain("bug at my end");
    expect(said).not.toContain("ask me again");
    expect(said).not.toContain("another go");
  });

  it("keeps the vendor's words out of it", () => {
    const said = humanise(new Error("400 invalid_request_error: unexpected field foo")).message;
    expect(said).not.toContain("invalid_request_error");
    expect(said).not.toContain("foo");
  });

  /** A page that timed out is still worth retrying, and must not be swept in. */
  it("still invites a retry for something transient", () => {
    const said = humanise(new Error("locator.click: Timeout 30000ms exceeded")).message;
    expect(said).toContain("try again");
  });
});
