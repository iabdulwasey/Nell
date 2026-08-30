/**
 * The handoff route, on the real loopback server.
 *
 * A handoff link is a session takeover: whoever opens it drives a browser signed
 * into the user's accounts. So the properties worth driving over a real socket
 * are the ones that stop it being one for anybody else — the `Host` check that
 * ends DNS rebinding before a token is read, the refusal of a grant that has
 * been handed back, and the fact that the link is **not** burned on first use,
 * because a takeover is held rather than submitted.
 *
 * The browser is stubbed. What this file is about is the boundary in front of
 * it, and a real Chromium here would test Playwright rather than the gate.
 */

import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { accessScopeForUser } from "@nell/shared";
import type { Pool } from "pg";
import type { ComputerAction } from "@nell/browser";
import { startVaultForm, type VaultForm } from "./vault-form.js";

const scope = accessScopeForUser("handoff-user");

/** Reached only if a request gets further than it should. */
const refusingPool = {
  connect: () => {
    throw new Error("The database was reached on a request that should have been refused.");
  },
} as unknown as Pool;

/** What the page did to the browser, so the test can assert on the far side. */
let performed: ComputerAction[] = [];
let handedBack: string[] = [];
let liveGrants = new Set<string>();

const machine = {
  screenshot: async () => "UE5H",
  act: async (action: ComputerAction) => {
    performed.push(action);
  },
  size: () => ({ width: 1440, height: 900 }),
};

let form: VaultForm | undefined;

async function start(): Promise<VaultForm> {
  form = await startVaultForm({
    pool: refusingPool,
    port: 0,
    handoff: {
      machineFor: (_scope, grantId) => (liveGrants.has(grantId) ? machine : undefined),
      finish: (_scope, grantId) => {
        liveGrants.delete(grantId);
        handedBack.push(grantId);
      },
    },
  });
  return form;
}

/** A request with a `Host` of our choosing, which `fetch` refuses to send. */
function send(
  url: string,
  options: { host?: string; method?: string; body?: string } = {}
): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? `127.0.0.1:${target.port}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => (body += chunk.toString()));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

afterEach(async () => {
  await form?.close();
  form = undefined;
  performed = [];
  handedBack = [];
  liveGrants = new Set();
});

describe("opening a handoff link", () => {
  it("serves the page, naming the site and the reason", async () => {
    const live = await start();
    liveGrants.add("g1");

    const link = live.handoffLink(scope, "g1", "It wants a person, not a bot.", "bookmyshow.com");
    const { status, body } = await send(link);

    expect(status).toBe(200);
    expect(body).toContain("bookmyshow.com");
    expect(body).toContain("It wants a person, not a bot.");
  });

  /**
   * The check that ends DNS rebinding before the token is even read. A page on
   * the open web resolving a name to 127.0.0.1 reaches this port; it does not
   * get to send our own `Host`.
   */
  it("refuses a request that did not come from this machine", async () => {
    const live = await start();
    liveGrants.add("g1");
    const link = live.handoffLink(scope, "g1", "why", "site");

    expect((await send(link, { host: "evil.example" })).status).toBe(403);
  });

  /**
   * A vault link is burned on first use because it is opened once and submitted
   * once. A takeover is *held* — burning it on the first screenshot would end
   * the handoff before the page had finished loading.
   */
  it("keeps working while the person is using it", async () => {
    const live = await start();
    liveGrants.add("g1");
    const link = live.handoffLink(scope, "g1", "why", "site");

    expect((await send(link)).status).toBe(200);
    expect((await send(`${link}/shot`)).body).toBe("UE5H");
    expect((await send(`${link}/shot`)).body).toBe("UE5H");
    expect((await send(link)).status).toBe(200);
  });
});

describe("driving through it", () => {
  it("forwards a click to the browser", async () => {
    const live = await start();
    liveGrants.add("g1");
    const link = live.handoffLink(scope, "g1", "why", "site");

    const { status } = await send(`${link}/act`, {
      method: "POST",
      body: JSON.stringify({ do: "click", x: 120, y: 340 }),
    });

    expect(status).toBe(200);
    expect(performed).toEqual([
      { action: "left_click", coordinate: { x: 120, y: 340 }, modifiers: [] },
    ]);
  });

  /** A parser that trusts its own client breaks the first time somebody curls it. */
  it("refuses a command it cannot read, and touches nothing", async () => {
    const live = await start();
    liveGrants.add("g1");
    const link = live.handoffLink(scope, "g1", "why", "site");

    expect(
      (await send(`${link}/act`, { method: "POST", body: '{"do":"navigate","url":"x"}' })).status
    ).toBe(400);
    expect((await send(`${link}/act`, { method: "POST", body: "not json" })).status).toBe(400);
    expect(performed).toEqual([]);
  });

  it("hands control back when the person says they are done", async () => {
    const live = await start();
    liveGrants.add("g1");
    const link = live.handoffLink(scope, "g1", "why", "site");

    expect((await send(`${link}/act`, { method: "POST", body: '{"do":"finish"}' })).status).toBe(
      200
    );
    expect(handedBack).toEqual(["g1"]);
  });

  /**
   * Once the agent has the controls back, the link is inert — a takeover left
   * open in a message history must not become a way back into the session.
   */
  it("is dead once the handoff is over", async () => {
    const live = await start();
    liveGrants.add("g1");
    const link = live.handoffLink(scope, "g1", "why", "site");
    await send(`${link}/act`, { method: "POST", body: '{"do":"finish"}' });

    const after = await send(`${link}/act`, {
      method: "POST",
      body: JSON.stringify({ do: "click", x: 1, y: 1 }),
    });
    expect(after.status).toBe(404);
    expect(performed).toEqual([]);
  });
});
