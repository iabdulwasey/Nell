/**
 * Recognising a wall.
 *
 * Watched live: asked for cinema showtimes, the agent hit Cloudflare on
 * Fandango, then AMC, then Cinemark, then BookMyShow, and reported each one as
 * "an access warning" it was "proceeding past". There was nothing to proceed
 * past — the page said *"Sorry, you have been blocked"* and offered a link to
 * email the site owner. It spent the entire step budget clicking a button it
 * had invented, and the user got twelve model calls and no showtimes.
 *
 * Two separate failures, and this file is about the second.
 *
 * The first is that a headless browser gets blocked at all, which is a property
 * of the browser and is addressed where the browser is launched. It will never
 * be fully solved: bot detection is an arms race, the far end of which is
 * someone's own machine, and pretending otherwise would be a promise this
 * cannot keep.
 *
 * The second is that the agent could not *tell*. A block page is not a hard
 * page to read — it says so, in words, in a heading — but a model asked "what
 * do I click next" will always find something to click, because that is the
 * question it was asked. Recognising the page deterministically and ending the
 * task is worth more than any amount of prompting, because it converts an
 * expensive nonsense answer into a cheap true one: *this site won't let me in.*
 *
 * Deliberately narrow. A false positive abandons a task that could have
 * succeeded, so every pattern here is a phrase that appears on a block page and
 * essentially nowhere else — not "denied", not "robot", not "captcha" on its
 * own, which appear in ordinary prose about these very subjects.
 */

import type { PageSnapshot } from "./perception.js";

export type BlockKind = "blocked" | "challenge" | "network-policy";

export interface BlockVerdict {
  readonly blocked: boolean;
  readonly kind?: BlockKind;
  /** The words on the page that decided it, so a wrong call is diagnosable. */
  readonly evidence?: string;
}

/**
 * A hard refusal. The site has decided, and no interaction on the page changes
 * it — which is what separates this from a challenge.
 */
const REFUSALS: readonly RegExp[] = [
  /\byou have been blocked\b/iu,
  /\bsorry, you have been blocked\b/iu,
  /\byou are unable to access\b/iu,
  /\baccess to this page has been denied\b/iu,
  /\bthis website is using a security service to protect itself\b/iu,
  /\byour access to this site has been limited\b/iu,
  /\berror 1015\b/iu,
  /\bray id\b/iu,
];

/**
 * A challenge. A person could get through this one, which is why it is reported
 * separately: it is the case a live-view handoff is *for*, where the agent stops
 * and the user finishes the step on their own phone.
 */
const CHALLENGES: readonly RegExp[] = [
  /\bverify (?:that )?you are (?:a )?human\b/iu,
  /\bchecking your browser before accessing\b/iu,
  /\bjust a moment\.{0,3}\s*$/iu,
  /\bour systems have detected unusual traffic\b/iu,
  /\bunusual traffic from your computer network\b/iu,
  /\bplease (?:complete|solve) the (?:security )?(?:check|challenge)\b/iu,
  /\benable javascript and cookies to continue\b/iu,
  /\bpress and hold\b.*\bconfirm you are human\b/isu,
];

/**
 * The user's own network, not the site.
 *
 * Found by looking, after four "access warnings" were assumed to be sites
 * refusing us. They were not: a corporate web filter on the user's own network
 * was blocking the category — "not allowed by your organization's policy",
 * "Warning Reason: Corporate", "Category: Entertainment".
 *
 * A separate kind because the agent's behaviour was otherwise reasonable and
 * still hopeless: the page offers a real PROCEED button, so clicking it is the
 * obvious move, and clicking it returns the same page. Nothing on the page is a
 * way through. Only the person whose network it is can act, so the only useful
 * response is to name which network is refusing, and stop.
 *
 * Phrased generically rather than per-vendor: Zscaler, Netskope, Cato, Umbrella
 * and Fortinet all say some version of these.
 */
const NETWORK_POLICY: readonly RegExp[] = [
  /\bnot allowed by your organization\W?s?\b/iu,
  /\bblocked access to website\b/iu,
  /\bwarning\s*[-\u2013\u2014]\s*restricted website\b/iu,
  /\bcontact your IT (?:department|service desk|administrator)\b/iu,
  /\bblocked by your network\b/iu,
];

/** Titles that are the whole story. */
const TITLES: readonly RegExp[] = [/^attention required/iu, /^just a moment/iu, /^access denied/iu];

/**
 * Is this page a wall?
 *
 * Reads the title and the visible text and nothing else. A block page is short
 * by nature, so only the opening of the text is considered — the same phrase
 * buried in a long article about bot detection is a page about the subject, not
 * an instance of it.
 */
export function detectBlock(snapshot: PageSnapshot): BlockVerdict {
  const title = snapshot.title.trim();
  // Optional on the snapshot: a page that produced no text cannot be a block
  // page, since a block page is text and nothing else.
  const body = (snapshot.text ?? "").slice(0, 2000);

  for (const pattern of TITLES) {
    if (pattern.test(title)) {
      return {
        blocked: true,
        kind: /just a moment/iu.test(title) ? "challenge" : "blocked",
        evidence: title,
      };
    }
  }

  // Before the site's own refusals: a filter page quotes the site it blocks, and
  // reporting "the site blocked you" sends the user to argue with the wrong party.
  for (const pattern of NETWORK_POLICY) {
    const hit = pattern.exec(body);
    if (hit) return { blocked: true, kind: "network-policy", evidence: hit[0] };
  }

  for (const pattern of REFUSALS) {
    const hit = pattern.exec(body);
    if (hit) return { blocked: true, kind: "blocked", evidence: hit[0] };
  }

  for (const pattern of CHALLENGES) {
    const hit = pattern.exec(body);
    if (hit) return { blocked: true, kind: "challenge", evidence: hit[0] };
  }

  return { blocked: false };
}

/**
 * What to tell the user.
 *
 * Names the site, because "I was blocked" prompts "by what?", and says what it
 * means rather than what happened technically — someone asking for showtimes
 * does not care which security vendor is involved. A challenge is described as
 * something a person could pass, since that is true and is the next thing to
 * offer.
 */
export function explainBlock(verdict: BlockVerdict, url: string): string {
  const site = hostOf(url);

  if (verdict.kind === "network-policy") {
    return (
      `${site} is blocked by the network this computer is on — a filter, not the site itself. ` +
      `Clicking through it doesn't work. On another network, or off the VPN, it would load.`
    );
  }

  return verdict.kind === "challenge"
    ? `${site} is asking me to prove I'm not a bot, which I can't do from here. ` +
        `If you open it yourself I can carry on from where you get to.`
    : `${site} blocks automated browsers, so I can't get in. ` +
        `Tell me another site to try, or open it yourself and I'll take it from there.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "That site";
  }
}
