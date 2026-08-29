/**
 * The vault, against a real database.
 *
 * The crypto has its own tests and they cover the algorithm. What is untested
 * until now is the thing that decides whether a password ever leaves: the origin
 * gate, standing between a stored secret and a page that wants it.
 *
 * So most of what follows is about refusal. A vault that hands over a credential
 * is ordinary; a vault that refuses correctly is the product.
 */

import { accessScopeForUser } from "@nell/shared";
import { StaticKeyProvider } from "@nell/vault";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, withWorkspace } from "./db.js";
import { forgetItem, itemsForOrigin, listItems, revealForOrigin, saveItem } from "./vault-store.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

let pool: Pool;
const keys = new StaticKeyProvider({ id: "k-test", material: randomBytes(32) });

const ada = accessScopeForUser("vault-ada");
const bob = accessScopeForUser("vault-bob");

const LOGIN = JSON.stringify({ username: "ada@example.com", password: "correct horse battery" });

async function wipe() {
  for (const scope of [ada, bob]) {
    await withWorkspace(pool, scope, async (client) => {
      await client.query("DELETE FROM vault_secrets");
      await client.query("DELETE FROM vault_items");
      await client.query("INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING", [
        scope.workspaceId,
      ]);
    });
  }
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

const save = (scope = ada, origins: readonly string[] = ["https://shop.example"]) =>
  withWorkspace(pool, scope, (client) =>
    saveItem(client, scope, keys, {
      kind: "login",
      label: "Shop",
      accountHint: "ada@example.com",
      origins,
      value: LOGIN,
    })
  );

describeDb("storing a secret", () => {
  it("round-trips through encryption when the origin is right", async () => {
    const id = await save();

    const outcome = await withWorkspace(pool, ada, (client) =>
      revealForOrigin(client, ada, keys, id, "https://shop.example/login")
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok)
      expect(JSON.parse(outcome.value.expose())).toMatchObject({ username: "ada@example.com" });
  });

  /**
   * What is on disk has to be useless on its own. A database backup, a leaked
   * dump, a misconfigured replica — none of them should contain a password.
   */
  it("never writes the plaintext", async () => {
    await save();

    const { rows } = await withWorkspace(pool, ada, (client) =>
      client.query<{ encrypted_value: string }>("SELECT encrypted_value FROM vault_secrets")
    );

    const stored = rows[0]?.encrypted_value ?? "";
    expect(stored).not.toContain("correct horse");
    expect(stored).not.toContain("ada@example.com");
    // The wire format carries a key id, so rotation needs no flag day.
    expect(stored.startsWith("v2.k-test.")).toBe(true);
  });

  it("keeps the value out of everything that lists items", async () => {
    await save();
    const items = await withWorkspace(pool, ada, (client) => listItems(client, ada));

    expect(items[0]?.label).toBe("Shop");
    expect(items[0]?.accountHint).toBe("ada@example.com");
    // There is nowhere on the summary type to put a secret, and nothing puts one.
    expect(JSON.stringify(items)).not.toContain("correct horse");
  });

  /**
   * A login nobody can use is a footgun stored for later — but the rule is about
   * logins, not about items.
   *
   * An address with no sites is a correctly stored address: it is filled in
   * wherever it is asked for, and scoping it to one shop would make the
   * intake-paperwork case impossible without making anything safer. Both halves
   * are asserted here, because a later change that makes the four kinds
   * "consistent" would break exactly one of them and look tidy doing it.
   */
  it("refuses a login with no site, and accepts an address with none", async () => {
    await expect(save(ada, [])).rejects.toThrow(/site/iu);

    const id = await withWorkspace(pool, ada, (client) =>
      saveItem(client, ada, keys, {
        kind: "address",
        label: "Home",
        origins: [],
        value: JSON.stringify({
          kind: "address",
          line1: "12 Rosewood Court",
          city: "Bristol",
          postalCode: "BS1",
          country: "GB",
        }),
      })
    );

    expect(id).toBeTruthy();
  });
});

describeDb("the origin gate", () => {
  /**
   * The failure this exists to prevent. FreeInstinct let the *model* say which
   * origin it expected, which makes the allowlist a suggestion: a page that
   * convinces the agent it is the bank gets the bank's password.
   */
  it("refuses a site that is not on the item's list", async () => {
    const id = await save();

    const outcome = await withWorkspace(pool, ada, (client) =>
      revealForOrigin(client, ada, keys, id, "https://evil.example/login")
    );

    expect(outcome.ok).toBe(false);
  });

  /** Exact origins only — "shop-example.com" must never satisfy "shop.example". */
  it("refuses a look-alike host", async () => {
    const id = await save();

    for (const impostor of [
      "https://shop.example.evil.com",
      "https://shop-example.com",
      "https://sub.shop.example",
    ]) {
      const outcome = await withWorkspace(pool, ada, (client) =>
        revealForOrigin(client, ada, keys, id, impostor)
      );
      expect(outcome.ok, impostor).toBe(false);
    }
  });

  /** A credential typed into a cleartext page is a credential given away. */
  it("refuses http where the item was stored for https", async () => {
    const id = await save();

    const outcome = await withWorkspace(pool, ada, (client) =>
      revealForOrigin(client, ada, keys, id, "http://shop.example/login")
    );

    expect(outcome.ok).toBe(false);
  });

  /**
   * Asked through the same check that guards the reveal. Two places deciding
   * what "matches" is one too many: the moment they disagree, the vault either
   * offers a credential it will then refuse, or hides one it would have given.
   */
  it("offers exactly the items it would hand over", async () => {
    const id = await save(ada, ["https://shop.example"]);

    const offered = await withWorkspace(pool, ada, (client) =>
      itemsForOrigin(client, ada, "https://shop.example/checkout")
    );
    expect(offered.map((item) => item.id)).toEqual([id]);

    const elsewhere = await withWorkspace(pool, ada, (client) =>
      itemsForOrigin(client, ada, "https://evil.example")
    );
    expect(elsewhere).toHaveLength(0);
  });
});

describeDb("one workspace's secrets", () => {
  /**
   * Reported as missing rather than forbidden, so a caller learns nothing about
   * what exists in somebody else's workspace.
   */
  it("cannot be read from another, even with the right id", async () => {
    const id = await save(ada);

    const outcome = await withWorkspace(pool, bob, (client) =>
      revealForOrigin(client, bob, keys, id, "https://shop.example/login")
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("No such");
  });

  it("does not appear in another's list", async () => {
    await save(ada);
    expect(await withWorkspace(pool, bob, (client) => listItems(client, bob))).toHaveLength(0);
  });
});

describeDb("forgetting", () => {
  it("removes the secret and the item together", async () => {
    const id = await save();

    expect(await withWorkspace(pool, ada, (client) => forgetItem(client, ada, id))).toBe(true);
    expect(await withWorkspace(pool, ada, (client) => listItems(client, ada))).toHaveLength(0);

    const { rows } = await withWorkspace(pool, ada, (client) =>
      client.query("SELECT 1 FROM vault_secrets")
    );
    expect(rows).toHaveLength(0);
  });

  it("cannot be used to delete another workspace's item", async () => {
    const id = await save(ada);
    expect(await withWorkspace(pool, bob, (client) => forgetItem(client, bob, id))).toBe(false);
    expect(await withWorkspace(pool, ada, (client) => listItems(client, ada))).toHaveLength(1);
  });
});
