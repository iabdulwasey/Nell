/**
 * A stored credential becoming something typed into a page.
 *
 * The store's own tests cover whether a secret comes back; these cover what the
 * browser is handed once it does. That is a different question, and the answers
 * that matter are mostly refusals: a field the DSL names but the item does not
 * hold, a second factor asked for where none is stored, an item asked for from
 * the wrong site.
 *
 * The one positive assertion worth having is the TOTP path, because it is the
 * only place here that *computes* rather than fetches — and getting it wrong
 * would put a permanent seed into a page instead of a code that expires in
 * thirty seconds.
 */

import { accessScopeForUser } from "@nell/shared";
import { StaticKeyProvider, totpAt } from "@nell/vault";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, withWorkspace } from "./db.js";
import { vaultAccess } from "./vault-secrets.js";
import { saveItem } from "./vault-store.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;
const keys = new StaticKeyProvider({ id: "k-test", material: randomBytes(32) });
const scope = accessScopeForUser("secrets-user");

/** From RFC 6238's own test vectors, so the code is checked against the spec. */
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

async function wipe() {
  await withWorkspace(pool, scope, async (client) => {
    await client.query("DELETE FROM vault_secrets");
    await client.query("DELETE FROM vault_items");
    await client.query("INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING", [
      scope.workspaceId,
    ]);
  });
}

beforeAll(async () => {
  if (!url) return;
  pool = createPool(url);
  await wipe();
});

beforeEach(async () => {
  if (!url) return;
  await wipe();
});

afterAll(async () => {
  if (!url) return;
  await wipe();
  await pool.end();
});

const store = (value: Record<string, unknown>, kind = "login") =>
  withWorkspace(pool, scope, (client) =>
    saveItem(client, scope, keys, {
      kind,
      label: "Shop",
      origins: ["https://shop.example"],
      value: JSON.stringify(value),
    })
  );

const login = {
  kind: "login",
  username: "ada@example.com",
  password: "correct horse battery",
  totpSecret: SEED,
  origins: ["https://shop.example"],
};

describeDb("handing a field to the browser", () => {
  it("gives the username and the password for the right site", async () => {
    const id = await store(login);
    const { secrets } = vaultAccess(pool, keys);

    const user = await secrets.reveal(scope, id, "https://shop.example", "username");
    const pass = await secrets.reveal(scope, id, "https://shop.example", "password");

    expect(user).toEqual({ ok: true, value: "ada@example.com" });
    expect(pass).toEqual({ ok: true, value: "correct horse battery" });
  });

  /**
   * The seed stays in the vault; only a code that expires leaves it.
   *
   * This is what makes vaulted 2FA safer than reading a code out of an inbox
   * rather than merely more convenient: no mailbox is opened, so the channel an
   * attacker would write into is not involved at all. If this returned the seed
   * — which is one wrong line — a permanent second factor would be typed into a
   * page and be in that page's DOM.
   */
  it("computes a code for the second factor and never yields the seed", async () => {
    const id = await store(login);
    const { secrets } = vaultAccess(pool, keys);

    const outcome = await secrets.reveal(scope, id, "https://shop.example", "totp");

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatch(/^\d{6}$/u);
    expect(outcome.value).not.toBe(SEED);
    // Same algorithm the site will run, not merely six digits of something.
    expect(outcome.value).toBe(totpAt({ secret: SEED }, Date.now()));
  });

  it("says so when a login has no second factor stored", async () => {
    const id = await store({ ...login, totpSecret: undefined });
    const { secrets } = vaultAccess(pool, keys);

    const outcome = await secrets.reveal(scope, id, "https://shop.example", "totp");

    expect(outcome.ok).toBe(false);
  });

  /**
   * The field names are generic so the model can describe a form without knowing
   * how anything is stored. The cost of that is combinations which do not exist,
   * and the only safe answer to one is no: filling a password box with a
   * cardholder name is a mistake that gets submitted before anyone reads it.
   */
  it("refuses a field the item does not have rather than substituting one", async () => {
    const id = await store(login);
    const { secrets } = vaultAccess(pool, keys);

    for (const field of ["number", "expiry", "name"]) {
      const outcome = await secrets.reveal(scope, id, "https://shop.example", field);
      expect(outcome.ok, field).toBe(false);
    }
  });

  /** The gate the whole design rests on, asserted here as well as in the store. */
  it("gives nothing at all from another site", async () => {
    const id = await store(login);
    const { secrets } = vaultAccess(pool, keys);

    const outcome = await secrets.reveal(scope, id, "https://evil.example", "password");

    expect(outcome.ok).toBe(false);
  });
});

describeDb("what the agent is shown", () => {
  /**
   * Offers must carry no value anywhere, because this is the one part of the
   * vault that goes into a prompt — and a prompt is the least private place in
   * the system. There is nowhere on `CredentialOffer` to put a secret; this
   * asserts nothing puts one there anyway.
   */
  it("lists an item for its own site and holds no value", async () => {
    const id = await store(login);
    const { offers } = vaultAccess(pool, keys);

    const here = await offers(scope, "https://shop.example");

    expect(here.map((item) => item.id)).toEqual([id]);
    expect(JSON.stringify(here)).not.toContain("correct horse");
    expect(JSON.stringify(here)).not.toContain(SEED);
  });

  /**
   * Nothing offered elsewhere, which is stronger than refusing later.
   *
   * A model told an id exists and then refused knows there is a credential for
   * that site and can say so on the page. Never mentioning it means a hostile
   * page cannot learn what the user has by getting the agent to try.
   */
  it("offers nothing on a site the item is not for", async () => {
    await store(login);
    const { offers } = vaultAccess(pool, keys);

    expect(await offers(scope, "https://evil.example")).toHaveLength(0);
    expect(await offers(scope, "https://shop.example.evil.com")).toHaveLength(0);
    // http where https was stored: a credential typed into a cleartext page is
    // a credential given away.
    expect(await offers(scope, "http://shop.example")).toHaveLength(0);
  });
});
