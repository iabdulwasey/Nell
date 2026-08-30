/**
 * Downloading a file, which nothing could do.
 *
 * Asked to "search the web, download an image of a monkey and give me it", Nell
 * searched, then *generated* one — because generating was the only thing on the
 * shelf that produced a picture. Search returns text snippets. The vendor's code
 * sandbox has no internet access. Drawing is not fetching. So the request was
 * impossible and the model did the nearest possible thing, which is the failure
 * mode a missing capability always has: something plausible happens instead.
 *
 * This is the missing piece. It takes a URL and returns the bytes as a file the
 * user receives, which covers "download that image", "get me that PDF", "save
 * the CSV from this link" — one capability rather than three.
 *
 * **The whole of the difficulty is that the model chooses the URL.** A fetcher
 * driven by a model that has just read a web page is a request forger: the page
 * says "see http://127.0.0.1:7431/…" and the model obligingly asks *our own
 * machine* for it. This process serves the vault form on loopback. So:
 *
 * - **http(s) only.** `file:`, `data:`, `gopher:` and the rest are not fetching.
 * - **The address is resolved first, and private space is refused.** Checking
 *   the hostname is not enough — `evil.example` resolving to `127.0.0.1` is the
 *   attack, and it looks like an ordinary domain right up until the connection.
 * - **Redirects are followed by hand**, re-checking each hop. A public URL that
 *   302s to `169.254.169.254` is the same attack wearing a hat.
 * - **A size cap**, because a model asked for "the file" cannot know it is 8GB.
 *
 * What comes back is untrusted, like any other third-party content: it reaches
 * the model as bytes and a content type, and nothing about it is an instruction.
 *
 * **Hosted, this matters far more than it does on a laptop.** On somebody's own
 * machine the worst reachable thing is the vault form on loopback: bad, and one
 * person's. On a server, `169.254.169.254` is the cloud metadata endpoint and
 * hands out instance credentials — one tenant's model fetching a URL a web page
 * suggested would compromise every tenant. The same code, a different blast
 * radius, which is why the checks here are written as refusals rather than
 * warnings.
 *
 * **And a limit that must not be papered over: this cannot win a DNS race.**
 * The address is resolved here and resolved *again* by the fetch, so a hostile
 * zero-TTL record can answer public to the first and private to the second.
 * Closing that properly means connecting to the checked address and carrying the
 * hostname for TLS, which is a different piece of work. Until then the honest
 * position is that this is defence in depth, and **a hosted deployment must also
 * block private egress at the network** — a rule that cannot be raced because it
 * does not depend on our code winning.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ClientTool, ProducedFile } from "./assistant.js";

/** Large enough for a photo or a report, small enough to be a mistake nobody pays for. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** Redirect hops. Enough for the usual CDN shuffle, few enough to end. */
export const MAX_REDIRECTS = 5;

/**
 * Address ranges that are not the public internet.
 *
 * Loopback, private, link-local (which is where cloud metadata services live),
 * carrier-grade NAT and unique-local v6. A fetcher that can reach any of these
 * is a way to ask our own host, or our neighbours, for things.
 */
function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/u.test(v6) || v6.startsWith("fe8") || v6.startsWith("fe9")) return true;
    /**
     * A v4 address mapped into v6 is still that v4 address — in either spelling.
     *
     * `::ffff:127.0.0.1` is the form people write, and it is **not** the form
     * that arrives: the URL parser canonicalises it to `::ffff:7f00:1`, so a
     * check that only knew the dotted-quad spelling let loopback straight
     * through. Both are handled by reading the last 32 bits, which is what the
     * notation means regardless of how it is written.
     */
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(v6);
    if (dotted?.[1]) return isPrivateAddress(dotted[1]);

    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(v6);
    if (hex?.[1] && hex[2]) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      return isPrivateAddress([high >> 8, high & 0xff, low >> 8, low & 0xff].map(String).join("."));
    }

    return false;
  }

  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined) return true;

  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local, including the cloud metadata address 169.254.169.254.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a >= 224;
}

export type UrlVerdict =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether this URL may be fetched, resolving it to decide.
 *
 * Exported because it is the security boundary, and a boundary nobody can test
 * on its own is a boundary nobody checks.
 */
export async function checkUrl(
  raw: string,
  resolve: (host: string) => Promise<readonly string[]> = defaultResolve
): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a URL I can fetch." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `I can only fetch http and https, not ${url.protocol}` };
  }

  /**
   * A literal address skips DNS but not the check — and IPv6 needs unwrapping.
   *
   * `new URL("http://[::1]/").hostname` is `"[::1]"`, **with the brackets**, so
   * `isIP` says it is not an address and the check fell through to resolving
   * the literal string as a hostname. `[::1]` and `[fd00::1]` were allowed
   * straight through. On a laptop that reaches the vault form; on a hosted box
   * it reaches whatever else that host is running.
   */
  const literal = url.hostname.replace(/^\[|\]$/gu, "");
  if (isIP(literal)) {
    return isPrivateAddress(literal)
      ? { ok: false, reason: "That address is on a private network, so I will not fetch it." }
      : { ok: true, url };
  }

  let addresses: readonly string[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    return { ok: false, reason: "I couldn't look up that host." };
  }

  if (addresses.length === 0) return { ok: false, reason: "That host has no address." };

  /**
   * *Every* address must be public, not merely the first.
   *
   * A host that resolves to one public and one private address is a host that
   * reaches the private one whenever the resolver feels like it.
   */
  if (addresses.some(isPrivateAddress)) {
    return {
      ok: false,
      reason: "That host resolves to a private network, so I will not fetch it.",
    };
  }

  return { ok: true, url };
}

async function defaultResolve(host: string): Promise<readonly string[]> {
  const results = await lookup(host, { all: true });
  return results.map((entry) => entry.address);
}

/** A filename from the URL, or one made from the content type. */
function nameFor(url: URL, mediaType: string): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const cleaned = last.replaceAll(/[^\w.-]/gu, "-").slice(0, 80);
  if (cleaned && cleaned.includes(".")) return cleaned;

  const extension = mediaType.split("/")[1]?.split(";")[0]?.replaceAll(/[^\w]/gu, "") ?? "bin";
  return `${cleaned || "download"}.${extension}`;
}

/**
 * The rung above a plain fetch: the same URL, read by a real browser.
 *
 * Declared here as a two-line port rather than taken as a `MachineHost`, and
 * that is a boundary rather than a style preference. `assist` has no browser and
 * must not acquire one — a browser carries the user's logins and can spend their
 * money, and every gate in Aegis exists because of that. What it gets instead is
 * a function that turns a URL into bytes. Whoever supplies it decides which
 * machine that runs on, and for model-chosen URLs the answer is a scratch one
 * holding none of the user's identity.
 */
export interface BrowserFetch {
  (url: string): Promise<{
    readonly status: number;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly finalUrl: string;
  }>;
}

/**
 * Bytes into something the model can use — a file to hand over, or a page to read.
 *
 * The branch is the whole reason a search result is usable. Both paths end here
 * so the plain fetch and the browser cannot disagree about what a PDF is.
 */
function present(
  data: Uint8Array,
  mediaType: string,
  url: URL,
  maxBytes: number
): { text: string; files?: readonly ProducedFile[] } {
  // Checked after reading too: `content-length` is a claim, not a promise.
  if (data.length > maxBytes) return { text: "That file turned out to be too large." };
  if (data.length === 0) return { text: "That URL returned an empty file." };

  if (mediaType.startsWith("text/html") || mediaType.includes("xhtml")) {
    const page = readablePage(new TextDecoder().decode(data), url);
    const images = page.images.length
      ? `\n\nImages on this page (fetch one to download it):\n${page.images.join("\n")}`
      : "";
    return { text: `Page at ${url.toString()}:\n\n${page.text}${images}` };
  }

  const file: ProducedFile = { name: nameFor(url, mediaType), mediaType, data };
  return {
    text: `Downloaded ${file.name} (${String(Math.round(data.length / 1024))}KB, ${mediaType}).`,
    files: [file],
  };
}

export interface FetchToolOptions {
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly maxBytes?: number;
  /** See `BrowserFetch`. Absent on an install with no machine — the tool still works. */
  readonly viaBrowser?: BrowserFetch;
}

/**
 * Answers that mean "not to you" rather than "not here".
 *
 * A 403 on an image CDN is hotlink protection, a 401 is a bot check, a 429 is
 * rate limiting by client, and 451/503 are what anti-bot services return while
 * pretending to be something else. Every one of them is the far end declining
 * *this client*, and every one of them is answered by being a real browser.
 * A 404 is not on the list: the file genuinely is not there, and asking again
 * more expensively will not conjure it.
 */
const REFUSED_A_CLIENT = new Set([401, 403, 405, 406, 429, 451, 503]);

/** Enough of a page for the model to choose from; not so much that it drowns. */
const MAX_PAGE_TEXT = 20_000;
const MAX_LINKS = 40;

/**
 * A page, reduced to what a model can act on: its words, and what it points at.
 *
 * This is what makes the search → page → file chain work. Search returns links
 * to *pages*, so a fetcher that could only hand back files would return a wall
 * of HTML for every one of them — the model would then have to parse markup in
 * its own context, badly, at great expense. Given the text and the image URLs it
 * can simply pick one and ask for it.
 */
function readablePage(html: string, base: URL): { text: string; images: readonly string[] } {
  const images: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw || images.length >= MAX_LINKS) return;
    try {
      const resolved = new URL(raw, base).toString();
      if (!images.includes(resolved)) images.push(resolved);
    } catch {
      /* A src we cannot resolve is a src we cannot offer. */
    }
  };

  // `og:image` first: it is the page's own answer to "which picture is this
  // page about", which is exactly the question being asked.
  for (const meta of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]*>/giu)) {
    add(/content=["']([^"']+)["']/iu.exec(meta[0])?.[1]);
  }
  for (const img of html.matchAll(/<img\b[^>]*>/giu)) {
    add(/\bsrc=["']([^"']+)["']/iu.exec(img[0])?.[1]);
  }

  const text = html
    .replaceAll(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/&nbsp;/gu, " ")
    .replaceAll(/&amp;/gu, "&")
    .replaceAll(/&lt;/gu, "<")
    .replaceAll(/&gt;/gu, ">")
    .replaceAll(/&quot;/gu, '"')
    .replaceAll(/&#39;/gu, "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

  return { text: text.slice(0, MAX_PAGE_TEXT), images };
}

export function fetchTool(options: FetchToolOptions = {}): ClientTool {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;

  return {
    name: "fetch_url",
    description:
      "Read a public http(s) URL. A file — an image, a PDF, a spreadsheet — is downloaded and " +
      "given to the user. A web page comes back as its text plus the image URLs it contains, so " +
      "you can follow a search result to the page and then fetch the picture on it. Use this " +
      "whenever they ask for something that already exists on the web, rather than generating a " +
      "substitute. If a site refuses, this retries as a real browser automatically.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The full http(s) URL of the file." },
      },
      required: ["url"],
    },

    async run(input) {
      const raw = (input as { url?: unknown }).url;
      if (typeof raw !== "string") return { text: "No URL was given." };

      let target = await checkUrl(raw, options.resolve);
      if (!target.ok) return { text: target.reason };

      /**
       * Redirects followed by hand, re-checking every hop.
       *
       * `redirect: "follow"` would let a public URL bounce to a private one
       * inside the fetch, where nothing gets to look at it — which is the whole
       * attack this function exists to refuse.
       */
      let response: Response | undefined;
      /**
       * Why the plain fetch did not work, kept rather than discarded.
       *
       * The first version of this returned "I couldn't reach that URL" for every
       * cause, which is the same mistake as the model error whose body went
       * unread: the explanation existed and was thrown away at the only point
       * that had it. It matters twice over here — the model needs to know
       * whether it was *refused* (try harder) or the file is *absent* (try
       * elsewhere), and so does the person reading the reply.
       */
      let plainFailure = "";
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        response = await fetchImpl(target.url, { redirect: "manual" }).catch((error: unknown) => {
          plainFailure = String((error as { cause?: unknown }).cause ?? error);
          return undefined;
        });
        if (!response) break;

        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || !location) break;

        const next = await checkUrl(new URL(location, target.url).toString(), options.resolve);
        if (!next.ok)
          return { text: `That link redirects somewhere I will not follow. ${next.reason}` };
        target = next;
        response = undefined;
      }

      /**
       * The rung the model was missing, and the reason it drew a monkey instead
       * of fetching one: a bare fetch that is refused was the end of the road,
       * so the only thing left on the shelf that produced a picture was the
       * thing that draws.
       *
       * Escalation is automatic rather than a second tool the model must know to
       * reach for, because "which HTTP client gets past this CDN" is plumbing
       * and the model should not have to have an opinion about it. It asked for
       * a file; getting the file is our problem.
       */
      const refused = !response || REFUSED_A_CLIENT.has(response.status);
      if (refused && options.viaBrowser) {
        const asBrowser = await options
          .viaBrowser(target.url.toString())
          .catch((error: unknown) => String(error));

        if (typeof asBrowser !== "string" && asBrowser.status < 400) {
          return present(
            asBrowser.bytes,
            asBrowser.mediaType,
            new URL(asBrowser.finalUrl),
            maxBytes
          );
        }
        plainFailure = typeof asBrowser === "string" ? asBrowser : plainFailure;
      }

      if (!response) {
        return {
          text: `I couldn't reach that URL${plainFailure ? `: ${plainFailure}` : "."}`,
        };
      }
      if (!response.ok) {
        return {
          text:
            `That URL returned ${String(response.status)}` +
            (REFUSED_A_CLIENT.has(response.status)
              ? " — the site is refusing automated requests. Try a different source."
              : "."),
        };
      }

      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        return {
          text: `That file is ${String(Math.round(declared / 1_000_000))}MB, which is too large.`,
        };
      }

      const mediaType = (response.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]!
        .trim();

      return present(new Uint8Array(await response.arrayBuffer()), mediaType, target.url, maxBytes);
    },
  };
}
