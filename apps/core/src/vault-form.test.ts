/**
 * The page that takes a password.
 *
 * Everything here is about refusal, because the interesting question is not
 * whether a form saves a form — it is what happens to the requests nobody
 * intended to send. A loopback server that collects credentials has exactly
 * three ways to be reached by something other than the person sitting at the
 * computer, and each has a test.
 *
 * The database is not involved. These assert the gate in front of it, and a
 * request that gets far enough to attempt a write has already passed everything
 * this file exists to check.
 */

import { afterEach, describe, expect, it } from "vitest";
import { accessScopeForUser } from "@nell/shared";
import { StaticKeyProvider } from "@nell/vault";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { Pool } from "pg";
import { LINK_TTL_MS, startVaultForm, type VaultForm } from "./vault-form.js";

const scope = accessScopeForUser("form-user");
const keys = new StaticKeyProvider({ id: "k-test", material: randomBytes(32) });

/**
 * Fails the test if it is ever used.
 *
 * Every case below should be refused before anything is written, so a query
 * reaching the database means the gate did not hold — which is exactly the
 * failure worth being loud about rather than a detail to stub over.
 */
const refusingPool = {
  connect: () => {
    throw new Error("The database was reached on a request that should have been refused.");
  },
} as unknown as Pool;

/** A GET with a `Host` of our choosing, which `fetch` will not send. */
function statusWithHost(url: string, host: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: target.port, path: target.pathname, headers: { Host: host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.on("error", reject);
    request.end();
  });
}

let form: VaultForm | undefined;
let clock = 1_700_000_000_000;

async function start(pool: Pool = refusingPool): Promise<VaultForm> {
  form = await startVaultForm({ pool, keys, port: 0, now: () => clock });
  return form;
}

afterEach(async () => {
  await form?.close();
  form = undefined;
  clock = 1_700_000_000_000;
});

describe("reaching the form", () => {
  it("serves the page for a freshly minted link", async () => {
    const url = (await start()).link(scope, "https://shop.example");
    const response = await fetch(url);

    expect(response.status).toBe(200);
    const html = await response.text();
    // Shown rather than asked for, so the login is bound to the page the browser
    // was actually on and there is no box in which to change it.
    expect(html).toContain("shop.example");
    expect(html).not.toContain('name="origin"');
    expect(html).toContain('name="password"');
    // All four sections are reachable, not just the one the link opened.
    for (const section of ["Logins", "Addresses", "Cards", "Phones"]) {
      expect(html, section).toContain(section);
    }
  });

  /**
   * The one real attack on a loopback server.
   *
   * A page on the open web cannot read from 127.0.0.1, but it can point a
   * hostname at it and make the browser send a request — the browser believes it
   * is talking to `evil.example` and sends that in `Host`. Nothing else about
   * such a request distinguishes it from a local one.
   */
  it("refuses a request whose Host is not loopback", async () => {
    const url = (await start()).link(scope);

    /**
     * Sent with `node:http` rather than `fetch`, which is not a detail.
     *
     * `Host` is a forbidden header: `fetch` silently drops any attempt to set
     * one and writes the real target instead. Written with `fetch` this test
     * passed the *correct* host, got a 200, and read as the server ignoring the
     * check — a test that could only ever have proven the thing it was aimed at
     * was untestable that way. A browser under a rebinding attack sends the
     * attacker's hostname because that is genuinely what it dialled, so the
     * request has to be made at the level where the header is real.
     */
    expect(await statusWithHost(url, "evil.example")).toBe(403);
    expect(await statusWithHost(url, "127.0.0.1")).toBe(200);
  });

  /**
   * The agent→human handoff, which is the flow this page exists inside.
   *
   * The agent hits a sign-in, and the form opens knowing the site and the email
   * — so the only thing left to type is the one thing that has to be typed here.
   * Neither value came from the model: the site is the browser's live URL and
   * the account is what the user has saved before.
   */
  it("opens with the site and the known account already in it", async () => {
    form = await startVaultForm({
      pool: refusingPool,
      keys,
      port: 0,
      now: () => clock,
      knownAccount: () => Promise.resolve("ada@example.com"),
    });

    const html = await (await fetch(form.link(scope, "https://airline.example"))).text();

    expect(html).toContain("airline.example");
    expect(html).toContain('value="ada@example.com"');

    /**
     * The cursor starts at the first box with nothing in it — which, with the
     * username already known, is Name rather than Username. Asserted as "the
     * first empty one" rather than by naming a field, so reordering the form
     * cannot leave the focus somewhere the person has to click past.
     */
    const focused = /<input name="([a-z]+)"[\s\S]*?autofocus/u.exec(html)?.[1];
    expect(focused).toBe("label");
    expect(html).not.toMatch(/name="username"[\s\S]*?autofocus/u);
  });

  /**
   * There is no parameter that could carry one, and this asserts nothing grows
   * one by accident. A password field arriving with something already in it is a
   * field people submit without reading — which is the whole failure mode this
   * page is built to avoid.
   */
  it("never prefills the password, whatever else is known", async () => {
    form = await startVaultForm({
      pool: refusingPool,
      keys,
      port: 0,
      now: () => clock,
      knownAccount: () => Promise.resolve("ada@example.com"),
    });

    const html = await (await fetch(form.link(scope, "https://airline.example"))).text();
    const field = /<input name="password"[\s\S]*?>/u.exec(html)?.[0] ?? "";

    expect(field).toContain('type="password"');
    // No value attribute at all — not an empty one, which is a weaker claim
    // that an accidental prefill could later satisfy.
    expect(field).not.toContain("value=");
  });

  /**
   * A first credential has nothing to go on, and a database that is down is not
   * a reason to refuse a password someone is standing there trying to give us.
   */
  it("still opens when nothing is known and when the lookup fails", async () => {
    form = await startVaultForm({
      pool: refusingPool,
      keys,
      port: 0,
      now: () => clock,
      knownAccount: () => Promise.reject(new Error("database is down")),
    });

    const response = await fetch(form.link(scope));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="username"');
  });

  it("refuses a token nobody minted", async () => {
    const url = (await start()).link(scope);
    const forged = url.replace(/\/v\/.*$/u, `/v/${randomBytes(32).toString("base64url")}`);

    expect((await fetch(forged)).status).toBe(404);
  });

  /**
   * A link in a chat history is a link that outlives the reason it was sent.
   */
  it("refuses a link once its ten minutes are up", async () => {
    const url = (await start()).link(scope);
    clock += LINK_TTL_MS + 1;

    expect((await fetch(url)).status).toBe(404);
  });

  it("refuses methods that are neither reading nor submitting the form", async () => {
    const url = (await start()).link(scope);

    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  });
});

describe("submitting", () => {
  const body = (fields: Record<string, string>) =>
    ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }) satisfies RequestInit;

  /**
   * Re-rendered rather than saved, and the token is deliberately *not* consumed:
   * a missing field is a typo, and making someone ask for a new link because they
   * forgot the username would train them to keep a link lying around.
   */
  it("asks again when a field is missing, without saving", async () => {
    const url = (await start()).link(scope);
    const response = await fetch(url, body({ origin: "https://shop.example", username: "ada" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("username and a password are needed");
    // Still live, because nothing was stored.
    expect((await fetch(url)).status).toBe(200);
  });

  /**
   * Consumed before the write, so a failure cannot hand back an unlimited link.
   *
   * Asserted against a pool that throws: the save fails, and the link must still
   * be dead afterwards. Releasing the token on failure is the natural way to
   * write this and it is wrong — it turns single-use into "single *successful*
   * use", which is unlimited for anyone who can make it fail.
   */
  it("burns the link even when the save fails", async () => {
    const url = (await start()).link(scope);

    const attempt = await fetch(
      url,
      body({ origin: "https://shop.example", username: "ada", password: "hunter2" })
    );
    expect(attempt.status).toBe(400);

    expect((await fetch(url)).status).toBe(404);
  });
});
