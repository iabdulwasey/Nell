/**
 * Start Nell.
 *
 * Reads configuration from the environment, refuses to start on anything
 * missing, and says which — a process that boots and then silently does nothing
 * is harder to diagnose than one that will not boot.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserExecutor } from "@nell/aegis";
import { keysFromEnv, providerFor } from "@nell/agent";
import { LocalBrowserProvider } from "@nell/browser/adapters";
import { accessScopeForUser } from "@nell/shared";
import { anthropicSearchProvider } from "@nell/integrations";
import { imageTool, type Capability } from "@nell/agent";
import { EnvKeyProvider } from "@nell/vault";
import { auditSink, readAudit } from "./audit-store.js";
import { installDurableTasks, shutdownDurableTasks } from "./durable-tasks.js";
import { assertRlsEnforceable, createPool, withWorkspace } from "./db.js";
import { run } from "./nell.js";
import { vaultAccess } from "./vault-secrets.js";
import { startVaultForm } from "./vault-form.js";
import { forgetItem, listItems } from "./vault-store.js";
import { runTicker } from "./ticker.js";
import { sendMessage } from "./telegram-poll.js";
import { WorkspaceSessions } from "./workspace-session.js";

const token = process.env["TELEGRAM_BOT_TOKEN"];
const databaseUrl = process.env["DATABASE_URL"];
const modelId = process.env["NELL_MODEL"] ?? "anthropic/claude-sonnet-4-5";
const startUrl = process.env["NELL_START_URL"] ?? "https://example.com";

/**
 * Who Nell answers to.
 *
 * Anyone can message a Telegram bot, so this list is the difference between an
 * assistant and a public service with someone else's credentials.
 */
const owner = process.env["NELL_OWNER_TELEGRAM_ID"];

const missing = [
  ["TELEGRAM_BOT_TOKEN", token],
  ["DATABASE_URL", databaseUrl],
  ["NELL_OWNER_TELEGRAM_ID", owner],
].filter(([, value]) => !value);

if (missing.length > 0) {
  console.error(`Missing: ${missing.map(([name]) => String(name)).join(", ")}`);
  process.exit(1);
}

const pool = createPool(databaseUrl!);
await assertRlsEnforceable(pool);

/**
 * Where the browser lives between runs.
 *
 * Set by default rather than opt-in, because the machine being *old* is the
 * point: cookies, storage and the profile a site has come to recognise all
 * accumulate, and a site that has seen this browser before asks fewer
 * questions. A profile that does not outlive the process accumulates nothing,
 * and this process restarts often.
 *
 * Under the user's home rather than a temp directory, for the same reason.
 */
const profileRoot = process.env["NELL_PROFILE_ROOT"] ?? join(homedir(), ".nell", "profiles");

/** Where files the user sends are kept, one directory per workspace. */
const fileRoot = process.env["NELL_FILE_ROOT"] ?? join(homedir(), ".nell", "files");

const browser = new LocalBrowserProvider({
  headless: process.env["NELL_HEADED"] !== "1",
  profileRoot,
});
const sessions = new WorkspaceSessions({ provider: browser, startUrl });

/**
 * The vault's key, or an explanation instead of one.
 *
 * Optional, and loudly so. Nell runs without it — it simply reaches a sign-in
 * and stops, which is what it did before the vault had a database. What it must
 * never do is start without a key and quietly store secrets somewhere else, so
 * the absence is reported with the one command that fixes it rather than left to
 * be discovered at a login wall.
 */
const vaultKeys = (() => {
  if (!process.env["SECRET_ENCRYPTION_KEY"]) {
    console.log("vault: off — set SECRET_ENCRYPTION_KEY (openssl rand -base64 32) to enable");
    return undefined;
  }
  try {
    return new EnvKeyProvider(process.env);
  } catch (error) {
    // A malformed key is a different problem from a missing one, and silently
    // treating it as missing would hide a typo in the thing guarding passwords.
    console.error(`vault: ${error instanceof Error ? error.message : "key unreadable"}`);
    process.exit(1);
  }
})();

const vault = vaultKeys ? vaultAccess(pool, vaultKeys) : undefined;

/**
 * One chain, for the one workspace this process serves.
 *
 * A hash chain is per-workspace by construction — `appendEntry` refuses to
 * interleave two — so the sink is bound here rather than created per call.
 */
const audit = auditSink(pool, accessScopeForUser(`tg-${owner!}`), (note) => {
  console.error(note);
});

/** Supplied rather than taken inside, so audit timestamps stay testable. */
const stamp = () => new Date().toISOString();

/**
 * One chokepoint for the life of the process.
 *
 * It holds taint state and spend approvals, and both belong to the session
 * rather than to a task — a password filled during one task is still filled
 * during the next, on the same open page.
 *
 * The secret source goes *here* rather than to the agent, and that placement is
 * the security property. Everything above this line handles ids; the decryption
 * happens on the far side, after the origin has been read off the live session,
 * and the taint machine starts watching the moment a value lands in a field.
 */
const executor = new BrowserExecutor({
  driver: browser,
  ...(vault ? { secrets: vault.secrets } : {}),
  /**
   * Every consequential step gets written down.
   *
   * The executor has called `record` at each of them since Phase 0 and nothing
   * ever passed it a sink, so the calls were no-ops on `undefined` — which was
   * survivable while the agent could only read public pages, and stopped being
   * survivable the day it started typing passwords into them.
   *
   * Bound to the one workspace this process serves, because a hash chain is
   * per-workspace and interleaving two produces a chain nobody can verify.
   */
  audit,
});

/**
 * A search vendor, not a model choice.
 *
 * Reachable with an Anthropic key in the same way Brave's is reachable with a
 * Brave key, and independent of `NELL_MODEL` — a workspace driving its agent
 * with DeepSeek or a local model still searches through this. Absent, the agent
 * still works and simply cannot get past a search engine's captcha.
 */
const anthropicKey = process.env["ANTHROPIC_API_KEY"];

/**
 * A vendor that draws.
 *
 * Anthropic reasons, reads and runs code but cannot make a picture, so this is
 * handed to it as a tool rather than being routed to in advance — it decides
 * when a picture is wanted and writes the prompt itself.
 */
const googleKey = process.env["GOOGLE_API_KEY"];
const specialists = googleKey ? [imageTool({ apiKey: googleKey })] : [];
const search = anthropicKey ? anthropicSearchProvider({ apiKey: anthropicKey }) : undefined;

/**
 * The page a password is typed into, served on loopback.
 *
 * Only started when there is a key to encrypt with — a form that collects
 * credentials and has nowhere to put them is worse than no form.
 */
const form =
  vaultKeys && vault
    ? await startVaultForm({
        pool,
        keys: vaultKeys,
        // So the form opens with the email already in it and only the password
        // left to type — the part that must be typed there, and the only part.
        knownAccount: vault.knownAccount,
        // The item id and its kind, never the value — an audit log that records
        // secrets is a second copy of the vault with no encryption on it.
        onSaved: (scope, kind, itemId) =>
          audit.record({ action: "secret.write", subject: itemId, detail: { kind }, at: stamp() }),
      })
    : undefined;
if (form) console.log("vault: on");

/**
 * Durable execution, when a system database is reachable.
 *
 * Launching is also what recovers whatever the last process left unfinished, so
 * this happens before the message poll starts — otherwise a recovered task and
 * a fresh message could race for the same browser.
 *
 * Optional and quiet about it: an install without it works exactly as before,
 * and loses a task if the process dies mid-flight. Refusing to start over a
 * missing durable engine would be a worse trade than the guarantee is worth.
 */
const durableEngine = await installDurableTasks(databaseUrl!, {
  run: async () => {
    // Tasks are started by the message loop and made durable step by step; a
    // recovered workflow re-enters those steps rather than being re-dispatched
    // from here. Deliberately empty rather than absent, so a recovered
    // workflow completes instead of throwing.
  },
  log: (line) => {
    console.log(line);
  },
}).catch((error: unknown) => {
  console.log(`durable: off — ${error instanceof Error ? error.message : "engine unavailable"}`);
  return undefined;
});

if (durableEngine) console.log("durable: on");

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nstopping");
    controller.abort();
  });
}

console.log(`model: ${modelId}`);
console.log(`profiles: ${profileRoot}`);
console.log(`owner: telegram ${owner!}`);

/**
 * The heartbeat runs beside the poll, not inside it.
 *
 * The poll spends most of its life blocked on a 25-second long poll; hanging
 * scheduled work off it would mean a 6am briefing arriving whenever the next
 * message happened to come in, which overnight is never.
 *
 * Scoped to the workspaces this process actually serves. Row-level security
 * means a query outside a workspace matches nothing, and a scheduler that swept
 * every tenant would need a role with a policy written for it — a real design
 * decision, not something to reach for a superuser connection over.
 */
const resolvedModel = providerFor(modelId, keysFromEnv(process.env));
const ticking = resolvedModel.ok
  ? runTicker(
      {
        pool,
        browser,
        sessions,
        executor,
        model: resolvedModel.provider,
        modelId,
        ...(search ? { search } : {}),
        send: (threadRef, text) => sendMessage({ token: token!, chatId: threadRef, text }),
        log: (line) => {
          console.log(line);
        },
      },
      [accessScopeForUser(`tg-${owner!}`)],
      controller.signal
    )
  : Promise.resolve();

await run(
  {
    pool,
    browser,
    keys: keysFromEnv(process.env),
    modelId,
    telegramToken: token!,
    knownSenders: new Map([[owner!, `tg-${owner!}`]]),
    sessions,
    executor,
    fileRoot,
    /**
     * Which vendors this install has a key for.
     *
     * Used only to suggest the missing one: telling somebody to add an OpenAI
     * key when they already have one is worse than saying nothing.
     */
    vendorKeys: new Set(
      [
        anthropicKey ? "anthropic" : "",
        process.env["OPENAI_API_KEY"] ? "openai" : "",
        googleKey ? "google" : "",
        process.env["DEEPSEEK_API_KEY"] ? "deepseek" : "",
      ].filter(Boolean)
    ),
    ...(anthropicKey ? { assistKey: anthropicKey, assistModel: "claude-sonnet-4-5" } : {}),
    ...(specialists.length > 0 ? { tools: specialists } : {}),
    ...(vault && form && vaultKeys
      ? {
          vault: {
            list: (scope) => withWorkspace(pool, scope, (client) => listItems(client, scope)),
            forget: async (scope, itemId) => {
              const gone = await withWorkspace(pool, scope, (client) =>
                forgetItem(client, scope, itemId)
              );
              // Recorded only when something was actually removed. An entry for
              // a delete that deleted nothing is a false memory.
              if (gone) {
                await audit.record({ action: "secret.delete", subject: itemId, at: stamp() });
              }
              return gone;
            },
            link: form.link,
            offers: vault.offers,
            knownAccount: vault.knownAccount,
          },
        }
      : {}),
    /**
     * What this install can actually do.
     *
     * `assist` needs a vendor with server-side tools — searching and a code
     * sandbox — which is where almost everything now happens. `image` is absent
     * because generating pictures needs a vendor that makes them, and none is
     * configured here. A plan reaching for either is told so rather than failing
     * partway through with nothing to show.
     */
    capabilities: new Set<Capability>(anthropicKey ? ["assist", "browse"] : ["browse"]),
    /** What was done, chained so an edit to the record is detectable. */
    audit: (scope) => readAudit(pool, scope),
    ...(durableEngine
      ? { durably: <T>(name: string, fn: () => Promise<T>) => durableEngine.step(name, fn) }
      : {}),
    ...(search ? { search } : {}),
    log: (line) => {
      console.log(line);
    },
  },
  controller.signal
);

await ticking;
await shutdownDurableTasks();
await form?.close();
await sessions.close();
await browser.shutdown();
await pool.end();
