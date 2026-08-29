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
import { withWorkspace } from "./db.js";
import { saveItem } from "./vault-store.js";

/** Long enough that a link left in a terminal is not a standing key. */
export const LINK_TTL_MS = 10 * 60 * 1000;

/** A form is a few hundred bytes; anything larger is not one. */
const MAX_BODY = 16 * 1024;

interface Pending {
  readonly scope: AccessScope;
  /** Prefilled when the agent hit a specific wall. Empty when the user asked. */
  readonly origin: string;
  readonly expiresAt: number;
}

export interface VaultFormOptions {
  readonly pool: Pool;
  readonly keys: KeyProvider;
  readonly port?: number;
  readonly now?: () => number;
}

export interface VaultForm {
  /** A one-time link for this workspace. `origin` prefills the form. */
  readonly link: (scope: AccessScope, origin?: string) => string;
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

    const token = (request.url ?? "").match(/^\/v\/([A-Za-z0-9_-]{16,128})$/u)?.[1];
    const entry = token ? find(pending, token) : undefined;

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

    if (request.method === "GET") return page(response, entry.value.origin, "");

    if (request.method !== "POST") return plain(response, 405, "No.");

    const body = await read(request);
    if (body === undefined) return plain(response, 413, "Too much.");

    const form = new URLSearchParams(body);
    const origin = (form.get("origin") ?? "").trim();
    const username = (form.get("username") ?? "").trim();
    const password = form.get("password") ?? "";
    const totpSecret = (form.get("totp") ?? "").trim();
    const label = (form.get("label") ?? "").trim() || hostOf(origin) || "Login";

    if (!origin || !username || !password) {
      return page(response, origin, "A site, a username and a password are all needed.");
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

    try {
      await withWorkspace(options.pool, entry.value.scope, (client) =>
        saveItem(client, entry.value.scope, options.keys, {
          kind: "login",
          label,
          accountHint: username,
          origins: [origin],
          value: JSON.stringify({
            kind: "login",
            username,
            password,
            ...(totpSecret ? { totpSecret: totpSecret.replaceAll(/\s/gu, "").toUpperCase() } : {}),
            origins: [origin],
          }),
        })
      );
    } catch (error) {
      // The message can name the origin or the label. It can never name the
      // value, and nothing in `saveItem` puts one in an error.
      return plain(response, 400, error instanceof Error ? error.message : "That did not save.");
    }

    return plain(response, 200, `Saved for ${hostOf(origin) || origin}. You can close this tab.`);
  }

  const port = options.port ?? Number(process.env["NELL_VAULT_PORT"] ?? 7431);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Explicitly 127.0.0.1 rather than the default, which listens on every
    // interface — including the wifi.
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    link: (scope, origin) => {
      const token = randomBytes(32).toString("base64url");
      pending.set(token, { scope, origin: origin ?? "", expiresAt: now() + LINK_TTL_MS });
      return `http://127.0.0.1:${String(addressOf(server, port))}/v/${token}`;
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
function page(response: ServerResponse, origin: string, error: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });

  response.end(
    shell(`
      ${error ? `<p class="error">${escape(error)}</p>` : ""}
      <form method="post" autocomplete="off">
        <label>Site
          <input name="origin" value="${escape(origin)}" placeholder="https://example.com" required>
        </label>
        <label>Username or email
          <input name="username" autocapitalize="off" spellcheck="false" required>
        </label>
        <label>Password
          <input name="password" type="password" required>
        </label>
        <label>Two-factor seed <span class="hint">optional — the long code shown beside a QR</span>
          <input name="totp" autocapitalize="off" spellcheck="false" placeholder="JBSWY3DPEHPK3PXP">
        </label>
        <label>Name it <span class="hint">optional</span>
          <input name="label" placeholder="Airline">
        </label>
        <button type="submit">Save to vault</button>
      </form>
      <p class="note">
        Encrypted before it is written, and tied to the site above — Nell will not
        offer it anywhere else, whatever a page claims to be. It is typed into a
        form by the browser and never shown to the model.
      </p>
    `)
  );
}

function shell(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Nell — add a login</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.15rem; margin: 0 0 1.5rem; }
  label { display: block; margin-bottom: 1rem; font-size: .82rem; letter-spacing: .01em; }
  .hint { opacity: .55; font-weight: 400; }
  input { display: block; width: 100%; margin-top: .35rem; padding: .55rem .6rem; font: inherit;
          border: 1px solid color-mix(in srgb, currentColor 30%, transparent); border-radius: .4rem;
          background: transparent; color: inherit; }
  button { padding: .6rem 1.1rem; font: inherit; border-radius: .4rem; border: 0;
           background: currentColor; color: Canvas; cursor: pointer; }
  .note { font-size: .8rem; opacity: .62; margin-top: 1.5rem; }
  .error { color: #c0392b; font-size: .85rem; }
</style></head><body><h1>Nell — add a login</h1>${body}</body></html>`;
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
