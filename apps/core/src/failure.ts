/**
 * What a failure sounds like to the person waiting for it.
 *
 * Three code paths could put a raw technical string in front of the user, and
 * all three did: a Playwright exception became *"That step did not work on the
 * page: locator.click: Timeout 30000ms exceeded"*, a provider error became
 * *"The model is having trouble: <whatever the API returned>"*, and anything
 * thrown outside the loop became `error.message`, verbatim, whatever it was.
 *
 * None of that is information to someone who asked for cinema times. It is not
 * actionable, it is not reassuring, and it reads as the assistant being broken
 * rather than the page being difficult — which is usually the opposite of the
 * truth.
 *
 * So the rule is: **the user gets a sentence, and the log gets the detail.**
 * Nothing raw crosses the boundary. An unrecognised error produces a plain
 * generic line rather than its own text, because an error nobody has classified
 * yet is precisely the one most likely to read as gibberish.
 *
 * Every branch says what happened *and* what to do about it, because "it didn't
 * work" leaves someone holding a phone with no next move.
 */

export interface Failure {
  /** Shown to the user. Never contains vendor text. */
  readonly message: string;
  /** Kept for the log, never sent. */
  readonly detail: string;
}

const PATTERNS: readonly { readonly test: RegExp; readonly message: string }[] = [
  {
    // The most common by far: an element never appeared, or the page moved.
    test: /timeout|timed out|waiting for (?:locator|selector)/iu,
    message:
      "That page didn't respond the way I expected — it may have changed while I was working. Want me to try again, or try somewhere else?",
  },
  {
    test: /net::ERR|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|dns/iu,
    message: "I couldn't reach that site. It may be down, or the network here is blocking it.",
  },
  {
    test: /session not found|target (?:page|closed)|context .*closed|browser has been closed/iu,
    message: "My browser closed underneath me. Ask again and I'll open a fresh one.",
  },
  {
    test: /rate.?limit|429|overloaded|capacity|too many requests/iu,
    message: "The model is busy right now. Give it a minute and ask again.",
  },
  {
    test: /401|403|unauthorized|invalid.*api.?key|authentication/iu,
    // A configuration problem, not something the user did — and not something
    // they can fix by rephrasing, so it must not be described as a task failure.
    message: "My model key isn't being accepted, so I can't think right now. That one's for Abdul.",
  },
  {
    test: /insufficient|quota|billing|credit/iu,
    message: "My model account is out of credit, so I can't work on that. That one's for Abdul.",
  },
  {
    test: /ECONNABORTED|abort|cancell?ed/iu,
    message: "That took too long, so I stopped rather than leaving you waiting.",
  },
];

const GENERIC = "That didn't work and I couldn't tell why. Ask me again and I'll have another go.";

/**
 * Turn anything thrown into something worth reading.
 *
 * Matched against the message *and* the class name: Playwright reports a bare
 * `TimeoutError` whose message sometimes carries the useful part and sometimes
 * carries only a call log.
 */
export function humanise(error: unknown): Failure {
  const detail = detailOf(error);
  const haystack = error instanceof Error ? `${error.name} ${error.message}` : detail;

  for (const pattern of PATTERNS) {
    if (pattern.test.test(haystack)) return { message: pattern.message, detail };
  }

  return { message: GENERIC, detail };
}

/**
 * The whole first line, for the log.
 *
 * Playwright appends a call log — every locator it tried, with timings — which
 * is useful in a terminal and is noise anywhere else. This never reaches the
 * user; it exists so that when something does go wrong there is something to
 * read afterwards.
 */
function detailOf(error: unknown): string {
  if (error instanceof Error) {
    const first = error.message.split("\n")[0]?.trim() ?? "";
    return first ? `${error.name}: ${first}` : error.name;
  }
  return typeof error === "string" ? error : "unknown error";
}

/**
 * A failure that is already a sentence.
 *
 * Policy refusals, block pages and step limits are written for the user by the
 * code that produced them, and passing those through here would replace a
 * specific true statement with a vague one. The distinction is whether a human
 * wrote the string or a vendor did.
 */
export function alreadyReadable(message: string): Failure {
  return { message, detail: message };
}
