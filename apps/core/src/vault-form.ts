/**
 * Getting a password into the vault without sending it anywhere.
 *
 * The obvious way is to type it into the chat: Nell asks, the user answers, and
 * the bot deletes both messages. It works, and it is what most bots do. It also
 * means the password went to Telegram's servers, sat in a data centre, and was
 * removed afterwards by an API call that is assumed to have succeeded — which is
 * a convention, not a construction, and this project's entire claim is the
 * difference between those two words.
 *
 * So the secret never enters the chat. Nell sends a link to a page served by
 * this process, on loopback, that the person opens on the machine Nell runs on;
 * they type the password into a form that posts straight into the vault. The
 * bytes go from their keyboard to a socket on their own computer. No third party
 * is involved, so there is nothing to trust about one.
 *
 * The cost is honest and worth stating: it only works when you are at that
 * machine. That is the right trade for something you do once per site, at a
 * desk, and it is a much better trade than the alternative pretends to make.
 *
 * Three things stand between the port and the vault:
 *
 * - **Loopback only.** Bound to 127.0.0.1, so it is not on the network at all —
 *   not on the wifi, not reachable from another machine, nothing to firewall.
 * - **A token per link.** 32 random bytes, single-use, minutes long. Another
 *   process on the same machine can reach the port and gets nowhere without one.
 * - **A `Host` check.** A page on the open web can make a browser POST to
 *   127.0.0.1 — that is DNS rebinding, and it is the one real attack on a
 *   loopback server. Such a request arrives with the attacker's hostname in
 *   `Host`; requiring localhost there ends it, before the token is even read.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AccessScope } from "@nell/shared";
import type { KeyProvider } from "@nell/vault";
import type { Pool } from "pg";
import type { VaultItemKind } from "@nell/vault";
import { withWorkspace } from "./db.js";
import { formFor, FORMS, needsOrigin, type VaultKindForm } from "./vault-kinds.js";
import { saveItem } from "./vault-store.js";

/** Long enough that a link left in a terminal is not a standing key. */
export const LINK_TTL_MS = 10 * 60 * 1000;

/** A form is a few hundred bytes; anything larger is not one. */
const MAX_BODY = 16 * 1024;

interface Pending {
  readonly scope: AccessScope;
  /** Prefilled when the agent hit a specific wall. Empty when the user asked. */
  readonly origin: string;
  /** What is already known, so only the password has to be typed. */
  readonly username: string;
  readonly expiresAt: number;
}

/**
 * What is known about a workspace before the form is drawn.
 *
 * A function rather than a value, because it is answered when the link is
 * opened rather than when it is minted, and because the answer is a database
 * read that nothing should pay for on a link nobody clicks.
 *
 * Only ever a username or email. There is deliberately no way to prefill a
 * password: the point of this page is that the password is typed here, by a
 * person, and a field arriving with something already in it is a field people
 * accept without reading.
 */
export type KnownAccount = (scope: AccessScope) => Promise<string | undefined>;

/**
 * Editing a memory file, when the caller wants that route served too.
 *
 * `read` renders the document into the textarea; `save` is handed whatever came
 * back. Kept as two functions rather than a dependency on the memory store so
 * this file continues to know nothing about preferences, directives or how any
 * of them are parsed.
 */
export interface MemoryPage {
  readonly read: (scope: AccessScope) => Promise<string>;
  readonly save: (scope: AccessScope, markdown: string) => Promise<string>;
}

export interface VaultFormOptions {
  readonly pool: Pool;
  /**
   * Optional, because the memory page needs no vault.
   *
   * Absent means the vault routes are refused rather than the whole server
   * being unavailable — an install with no encryption key can still let someone
   * read and correct what Nell believes about them.
   */
  readonly keys?: KeyProvider;
  readonly memory?: MemoryPage;
  readonly port?: number;
  readonly now?: () => number;
  readonly knownAccount?: KnownAccount;
  /**
   * Called once an item is stored, so the write gets a receipt.
   *
   * A vault that records what it *uses* but not what was *put into it* leaves
   * the most interesting question unanswerable: where did this credential come
   * from, and when. Kept as a hook rather than a direct dependency so this file
   * still has nothing to do with hash chains.
   */
  readonly onSaved?: (scope: AccessScope, kind: VaultItemKind, itemId: string) => Promise<void>;
}

export interface VaultForm {
  /**
   * A one-time link for this workspace.
   *
   * `origin` prefills the site. `username` prefills the account, and is passed
   * when the caller already knows it — which is why the agent supplies neither
   * itself: the site comes from the live browser session and the account from
   * what the user has already told us.
   */
  readonly link: (
    scope: AccessScope,
    origin?: string,
    username?: string,
    kind?: VaultItemKind
  ) => string;
  /** A one-time link to read and edit `MEMORY.md`. */
  readonly memoryLink: (scope: AccessScope) => string;
  readonly close: () => Promise<void>;
}

export async function startVaultForm(options: VaultFormOptions): Promise<VaultForm> {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      plain(response, 500, "Something went wrong.");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    /**
     * Checked first, and on its own line, because it is the only defence here
     * against a request that did not come from the person at this computer.
     */
    if (!localHost(request.headers.host)) return plain(response, 403, "Not for you.");

    // Parsed against a fixed base so a malformed URL cannot throw here, and so
    // the query is read the same way whatever the client sent.
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = /^\/([vm])\/([A-Za-z0-9_-]{16,128})$/u.exec(url.pathname);
    const token = route?.[2];
    const entry = token ? find(pending, token) : undefined;
    const form = formFor(url.searchParams.get("kind"));

    // Expiry swept on the way past rather than on a timer: a link is only
    // interesting when someone is using it, and a stray interval keeps a
    // process alive at shutdown.
    for (const [key, value] of pending) if (value.expiresAt <= now()) pending.delete(key);

    if (!entry || entry.value.expiresAt <= now()) {
      return plain(
        response,
        404,
        "That link has expired or has already been used. Ask for a new one."
      );
    }

    /**
     * The memory page: read the document, edit it, save it back.
     *
     * The round trip is what makes the file approach real rather than a report.
     * `parseMemoryMarkdown` has existed since v1 with nothing calling it, so
     * `MEMORY.md` could be read and never corrected — and a memory you cannot
     * correct is one you have to trust rather than check.
     */
    if (route?.[1] === "m") {
      if (!options.memory) return plain(response, 404, "Memory editing is not enabled.");

      if (request.method === "GET") {
        const body = await options.memory.read(entry.value.scope);
        return memoryPage(response, entry.key, body, "");
      }
      if (request.method !== "POST") return plain(response, 405, "No.");

      const body = await read(request);
      if (body === undefined) return plain(response, 413, "Too much.");
      const markdown = new URLSearchParams(body).get("markdown") ?? "";

      // Burned before the write, like the vault form and for the same reason: a
      // link released only on success is unlimited for anyone who can fail.
      pending.delete(entry.key);
      const note = await options.memory.save(entry.value.scope, markdown);
      return plain(response, 200, note);
    }

    if (request.method === "GET") {
      /**
       * Asked at open time, not at mint time.
       *
       * The account is whatever the user has used before, and "before" can
       * include five minutes ago on a different link. Resolving it here means
       * the form is never stale, and a link nobody opens costs no query.
       *
       * Failure is silent and empty on purpose: an unreachable database should
       * produce a form with one blank field, not a page that will not load when
       * somebody is standing there trying to give us a password.
       */
      const known =
        entry.value.username ||
        (await options.knownAccount?.(entry.value.scope).catch(() => undefined)) ||
        "";
      return page(response, {
        form,
        token: entry.key,
        origin: entry.value.origin,
        values: { username: known },
        error: "",
      });
    }

    if (request.method !== "POST") return plain(response, 405, "No.");

    const body = await read(request);
    if (body === undefined) return plain(response, 413, "Too much.");

    const submitted = new URLSearchParams(body);
    const value = (name: string) => (submitted.get(name) ?? "").trim();

    /**
     * The site comes from the link where the agent supplied one, and from the
     * form only when it did not.
     *
     * Ordered that way deliberately: a login minted at a sign-in wall is bound
     * to the page the browser was actually on, and nothing typed into the form
     * can move it. Someone adding a login out of the blue has no such context
     * and is asked.
     */
    const origin = entry.value.origin || value("origin");
    const built = form.build(value, origin);

    if (!built.ok) {
      return page(response, {
        form,
        token: entry.key,
        origin,
        // What they typed, so a missing postcode does not cost them the rest.
        values: Object.fromEntries(form.fields.map((f) => [f.name, f.secret ? "" : value(f.name)])),
        error: built.why,
      });
    }

    /**
     * Consumed before the write, not after.
     *
     * A token released only on success is a token that survives every failed
     * attempt, which turns a single-use link into an unlimited one for as long
     * as something keeps going wrong. A user who mistypes asks for another link;
     * that is a fair price for the guarantee.
     */
    pending.delete(entry.key);

    let saved = "";
    if (!options.keys) {
      return plain(response, 400, "This install has no vault key, so nothing can be saved.");
    }

    try {
      saved = await withWorkspace(options.pool, entry.value.scope, (client) =>
        saveItem(client, entry.value.scope, options.keys!, {
          kind: form.kind,
          label: built.item.label,
          ...(built.item.accountHint ? { accountHint: built.item.accountHint } : {}),
          origins: built.item.origins,
          value: JSON.stringify(built.item.value),
        })
      );
    } catch (error) {
      // The message can name the site or the label. It can never name the value,
      // and nothing in `saveItem` puts one in an error.
      return plain(response, 400, error instanceof Error ? error.message : "That did not save.");
    }

    // After the write and outside its try: a failure to record must not read as
    // a failure to save, because the item is stored either way.
    await options.onSaved?.(entry.value.scope, form.kind, saved).catch(() => undefined);

    const where = hostOf(origin);
    return plain(response, 200, `Saved${where ? ` for ${where}` : ""}. You can close this tab.`);
  }

  const port = options.port ?? Number(process.env["NELL_VAULT_PORT"] ?? 7431);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Explicitly 127.0.0.1 rather than the default, which listens on every
    // interface — including the wifi.
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    link: (scope, origin, username, kind) => {
      const token = randomBytes(32).toString("base64url");
      pending.set(token, {
        scope,
        origin: origin ?? "",
        username: username ?? "",
        expiresAt: now() + LINK_TTL_MS,
      });
      const at = `http://127.0.0.1:${String(addressOf(server, port))}/v/${token}`;
      return kind && kind !== "login" ? `${at}?kind=${kind}` : at;
    },
    memoryLink: (scope) => {
      const token = randomBytes(32).toString("base64url");
      pending.set(token, {
        scope,
        origin: "",
        username: "",
        expiresAt: now() + LINK_TTL_MS,
      });
      return `http://127.0.0.1:${String(addressOf(server, port))}/m/${token}`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function addressOf(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallback;
}

/**
 * Only the loopback names, and the port is ignored.
 *
 * A browser sends `Host: 127.0.0.1:7431` for a link we minted and
 * `Host: evil.example` (or a rebound name) for anything else, which is the whole
 * distinction being drawn.
 */
function localHost(host: string | undefined): boolean {
  const name = (host ?? "").split(":")[0]?.toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

/**
 * Compared in constant time against every live token.
 *
 * A `Map` lookup would be simpler and, at 256 bits of entropy, almost certainly
 * fine. The reason not to is that this file sits beside `handoff.ts`, which does
 * compare in constant time, and a codebase where the discipline holds in one
 * place and not the neighbouring one is a codebase where nobody can tell which
 * rule was a decision. There are never more than a handful of live links.
 */
function find(
  pending: Map<string, Pending>,
  token: string
): { key: string; value: Pending } | undefined {
  const offered = Buffer.from(token);
  let found: { key: string; value: Pending } | undefined;

  for (const [key, value] of pending) {
    const candidate = Buffer.from(key);
    if (candidate.length !== offered.length) continue;
    if (timingSafeEqual(candidate, offered)) found = { key, value };
  }

  return found;
}

async function read(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

function plain(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // Nothing here should ever be stored, indexed, or sent as a referrer to
    // whatever the user opens next.
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end(shell(`<p class="note">${escape(text)}</p>`));
}

/**
 * The form.
 *
 * Deliberately one file with no external anything — no fonts, no scripts, no
 * images. Partly because a page that loads a resource is a page that tells
 * somebody it was opened, and partly because the whole point of this route is
 * that the bytes go nowhere.
 */
function page(
  response: ServerResponse,
  view: {
    readonly form: VaultKindForm;
    readonly token: string;
    readonly origin: string;
    readonly values: Readonly<Record<string, string | undefined>>;
    readonly error: string;
  }
): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });

  const { form, origin } = view;

  /**
   * Four tabs, so the four things a vault holds are visible rather than
   * remembered. Switching is a GET on the same token, which does not consume it.
   */
  const tabs = FORMS.map((other) => {
    const href = `/v/${view.token}${other.kind === "login" ? "" : `?kind=${other.kind}`}`;
    return other.kind === form.kind
      ? `<span class="tab here">${escape(other.section)}</span>`
      : `<a class="tab" href="${escape(href)}">${escape(other.section)}</a>`;
  }).join("");

  /**
   * The site is shown rather than asked for when the agent already knows it.
   *
   * That is the difference between three fields and four, and it is also the
   * safer arrangement: a login minted at a sign-in wall is bound to the page the
   * browser was actually on, and there is no box in which to change it to
   * somewhere else.
   */
  const site = !needsOrigin(form)
    ? ""
    : origin
      ? `<p class="bound">For <strong>${escape(hostOf(origin) || origin)}</strong></p>`
      : `<label>Site
           <input name="origin" placeholder="https://example.com" autocapitalize="off"
                  spellcheck="false" required>
         </label>`;

  // The first empty box gets the cursor, so a prefilled form starts where the
  // typing does.
  const firstEmpty = form.fields.find((field) => field.secret || !view.values[field.name])?.name;

  const fields = form.fields
    .map((field) => {
      /**
       * A secret field is rendered with no `value` attribute at all, rather than
       * with an empty one.
       *
       * The stronger shape: "there is nothing to prefill a password with" is a
       * property a reader can check by looking, and a test can assert without
       * having to reason about whether an empty string counts.
       */
      const value = field.secret ? undefined : (view.values[field.name] ?? "");
      return `<label>${escape(field.label)}${
        field.hint ? ` <span class="hint">${escape(field.hint)}</span>` : ""
      }
        <input name="${escape(field.name)}"${field.secret ? ' type="password"' : ""}
               ${value === undefined ? "" : `value="${escape(value)}"`}
               ${field.placeholder ? `placeholder="${escape(field.placeholder)}"` : ""}
               ${field.required ? "required" : ""}
               ${field.name === firstEmpty ? "autofocus" : ""}
               autocapitalize="off" spellcheck="false">
      </label>`;
    })
    .join("");

  response.end(
    shell(
      `<nav class="tabs">${tabs}</nav>
      ${view.error ? `<p class="error">${escape(view.error)}</p>` : ""}
      ${site}
      <form method="post" autocomplete="off">
        ${fields}
        <button type="submit">Save to vault</button>
      </form>
      <p class="note">Encrypted before it is written. ${escape(form.note ?? "")}</p>`
    )
  );
}

/** The document, in a box, with a save button. */
function memoryPage(response: ServerResponse, token: string, body: string, error: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });

  response.end(
    shell(
      `${error ? `<p class="error">${escape(error)}</p>` : ""}
      <form method="post" action="/m/${escape(token)}">
        <textarea name="markdown" rows="22" spellcheck="false">${escape(body)}</textarea>
        <button type="submit">Save</button>
      </form>
      <p class="note">
        This is what Nell reads before every task — not a summary of it. Edit a line
        to correct it, delete one to forget it. Lines it cannot parse are left alone
        rather than losing the rest of your edits.
      </p>`
    )
  );
}

function shell(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Nell — vault</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1.25rem; }
  .tabs { display: flex; gap: .15rem; margin: 0 0 1.6rem; flex-wrap: wrap; }
  .tab { font-size: .8rem; padding: .3rem .6rem; border-radius: .3rem; text-decoration: none;
         color: inherit; opacity: .5; }
  .tab.here { opacity: 1; background: color-mix(in srgb, currentColor 12%, transparent); }
  .bound { font-size: .85rem; margin: 0 0 1.1rem; opacity: .8; }
  label { display: block; margin-bottom: 1rem; font-size: .82rem; letter-spacing: .01em; }
  .hint { opacity: .55; font-weight: 400; }
  input { display: block; width: 100%; margin-top: .35rem; padding: .55rem .6rem; font: inherit;
          border: 1px solid color-mix(in srgb, currentColor 30%, transparent); border-radius: .4rem;
          background: transparent; color: inherit; }
  button { padding: .6rem 1.1rem; font: inherit; border-radius: .4rem; border: 0;
           background: currentColor; color: Canvas; cursor: pointer; }
  textarea { width: 100%; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
             padding: .7rem; border-radius: .4rem; background: transparent; color: inherit;
             border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
  .note { font-size: .8rem; opacity: .62; margin-top: 1.5rem; }
  .error { color: #c0392b; font-size: .85rem; }
</style></head><body>${body}</body></html>`;
}

function escape(value: string): string {
  return value.replaceAll(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
