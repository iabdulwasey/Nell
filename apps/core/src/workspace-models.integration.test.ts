/**
 * Whose keys, and whose choice — with more than one tenant in the database.
 *
 * These run against real Postgres because the property that matters most cannot
 * be tested any other way: **one workspace must not be able to read another's
 * API key**, and what makes that true is row-level security rather than the
 * queries being written carefully. A unit test with a fake client would assert
 * the care and prove nothing about the guarantee.
 *
 * The rest is the precedence `mergeAssignments` has defined since it was written
 * and never had a caller for — operator first, workspace over it, per capability.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { accessScopeForUser, type AccessScope } from "@nell/shared";
import { StaticKeyProvider } from "@nell/vault";
import { withWorkspace } from "./db.js";
import {
  assignmentFor,
  forgetKey,
  listKeys,
  readChoice,
  resolveKey,
  saveKey,
  setChoice,
  userChoiceAllowed,
} from "./workspace-models.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

/** A key of the right shape, so the crypto is exercised rather than stubbed. */
const keys = new StaticKeyProvider({ id: "k1", material: Buffer.alloc(32, 7) });

let pool: Pool;
let alice: AccessScope;
let bob: AccessScope;

beforeAll(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });

  const run = String(process.pid) + String(Date.now());
  alice = accessScopeForUser(`wm-alice-${run}`);
  bob = accessScopeForUser(`wm-bob-${run}`);

  for (const scope of [alice, bob]) {
    await pool.query(`INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      scope.workspaceId,
    ]);
  }
});

afterAll(async () => {
  if (!url) return;
  for (const scope of [alice, bob]) {
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [scope.workspaceId]).catch(() => {});
  }
  await pool.end();
});

describeDb("a workspace's own key", () => {
  it("is stored encrypted and comes back usable", async () => {
    await withWorkspace(pool, alice, (client) =>
      saveKey(client, alice, keys, "openai", "sk-alice-secret-1234")
    );

    const resolved = await withWorkspace(pool, alice, (client) =>
      resolveKey(client, alice, keys, "openai", "sk-operator")
    );
    expect(resolved).toBe("sk-alice-secret-1234");

    /**
     * What is on disk is not the key — read *inside* the workspace.
     *
     * The first version of this used the bare pool, which RLS correctly answers
     * with nothing, so there was no row to inspect. It failed loudly here; the
     * same mistake once passed vacuously elsewhere in this repo by comparing a
     * page against an empty string.
     */
    const stored = await withWorkspace(pool, alice, async (client) => {
      const { rows } = await client.query<{ ciphertext: string }>(
        `SELECT ciphertext FROM workspace_keys WHERE workspace_id = $1`,
        [alice.workspaceId]
      );
      return rows[0]?.ciphertext;
    });

    expect(stored).toBeDefined();
    expect(stored).not.toContain("sk-alice");
  });

  /**
   * The property the hosted tier rests on. Not "the query filters correctly" —
   * the query here asks for `openai` with no workspace clause of its own, and
   * RLS is what makes it return nothing.
   */
  it("cannot be read by another workspace", async () => {
    const asBob = await withWorkspace(pool, bob, (client) =>
      resolveKey(client, bob, keys, "openai", "sk-operator")
    );
    // Falls back to the operator's, which is exactly right: Bob has no key.
    expect(asBob).toBe("sk-operator");

    const bobSees = await withWorkspace(pool, bob, (client) => listKeys(client, bob));
    expect(bobSees).toHaveLength(0);
  });

  it("falls back to the operator's key when the workspace has none", async () => {
    const resolved = await withWorkspace(pool, bob, (client) =>
      resolveKey(client, bob, keys, "anthropic", "sk-operator-anthropic")
    );
    expect(resolved).toBe("sk-operator-anthropic");
  });

  /** Enough to recognise, never enough to use. */
  it("shows only the last four characters", async () => {
    const listed = await withWorkspace(pool, alice, (client) => listKeys(client, alice));
    expect(listed[0]?.hint).toBe("1234");
    expect(listed[0]?.vendor).toBe("openai");
  });

  it("can be replaced, and is not duplicated", async () => {
    await withWorkspace(pool, alice, (client) =>
      saveKey(client, alice, keys, "openai", "sk-alice-replaced-9999")
    );
    const listed = await withWorkspace(pool, alice, (client) => listKeys(client, alice));
    expect(listed.filter((entry) => entry.vendor === "openai")).toHaveLength(1);
    expect(listed[0]?.hint).toBe("9999");
  });

  it("can be forgotten, after which the operator's is used again", async () => {
    expect(await withWorkspace(pool, alice, (client) => forgetKey(client, alice, "openai"))).toBe(
      true
    );
    const resolved = await withWorkspace(pool, alice, (client) =>
      resolveKey(client, alice, keys, "openai", "sk-operator")
    );
    expect(resolved).toBe("sk-operator");
  });

  /**
   * A rotated master key leaves rows that will not decrypt. The honest
   * behaviour is the same as having no key — the operator's is used and the
   * settings screen can say so — rather than the process failing to start.
   */
  it("falls back rather than throwing when a key will not decrypt", async () => {
    await withWorkspace(pool, alice, (client) =>
      saveKey(client, alice, keys, "google", "sk-google-abcd")
    );

    const otherKey = new StaticKeyProvider({ id: "k2", material: Buffer.alloc(32, 9) });
    const resolved = await withWorkspace(pool, alice, (client) =>
      resolveKey(client, alice, otherKey, "google", "sk-operator-google")
    );
    expect(resolved).toBe("sk-operator-google");
  });
});

describeDb("whose choice of model", () => {
  it("leaves the operator's answer alone when the workspace has chosen nothing", async () => {
    const assignment = await withWorkspace(pool, bob, (client) =>
      assignmentFor(client, bob, { defaultModel: "anthropic/claude-sonnet-5" }, true)
    );
    expect(assignment.defaultModel).toBe("anthropic/claude-sonnet-5");
  });

  /**
   * Per capability, not per object. A workspace overriding only drawing must
   * keep the operator's choice for everything else — merging at the wrong depth
   * would silently discard settings the admin made.
   */
  it("merges a workspace override over the operator's, one capability at a time", async () => {
    await withWorkspace(pool, alice, (client) =>
      setChoice(client, alice, { overrides: { image: "openai/gpt-image-2" } })
    );

    const assignment = await withWorkspace(pool, alice, (client) =>
      assignmentFor(
        client,
        alice,
        {
          defaultModel: "anthropic/claude-sonnet-5",
          overrides: { code: "anthropic/claude-opus-5" },
        },
        true
      )
    );

    expect(assignment.overrides).toEqual({
      // The operator's, untouched.
      code: "anthropic/claude-opus-5",
      // The workspace's, on top.
      image: "openai/gpt-image-2",
    });
  });

  it("lets a workspace change the default model over the operator's", async () => {
    await withWorkspace(pool, alice, (client) =>
      setChoice(client, alice, { defaultModel: "openai/gpt-5.6", overrides: {} })
    );
    const assignment = await withWorkspace(pool, alice, (client) =>
      assignmentFor(client, alice, { defaultModel: "anthropic/claude-sonnet-5" }, true)
    );
    expect(assignment.defaultModel).toBe("openai/gpt-5.6");
  });

  /**
   * An operator selling a service has a real reason to say no: their margin
   * depends on which models run. When they do, the workspace layer is not read
   * at all rather than read and ignored — an unread row cannot be accidentally
   * honoured.
   */
  it("ignores the workspace entirely when the operator does not permit choice", async () => {
    const assignment = await withWorkspace(pool, alice, (client) =>
      assignmentFor(client, alice, { defaultModel: "anthropic/claude-sonnet-5" }, false)
    );
    expect(assignment.defaultModel).toBe("anthropic/claude-sonnet-5");
    expect(assignment.overrides).toEqual({});
  });

  it("keeps one workspace's choice out of another's", async () => {
    expect(await withWorkspace(pool, bob, (client) => readChoice(client, bob))).toBeUndefined();
  });
});

describe("the operator's policy", () => {
  /** One person running it for themselves must not have to ask themselves. */
  it("permits choice by default", () => {
    expect(userChoiceAllowed({})).toBe(true);
  });

  it("is turned off explicitly, in the spellings people use", () => {
    for (const value of ["0", "false", "no", "FALSE"]) {
      expect(userChoiceAllowed({ NELL_ALLOW_USER_MODELS: value }), value).toBe(false);
    }
  });
});
