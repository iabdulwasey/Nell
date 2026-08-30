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
import { LocalBrowserProvider, LocalMachineHost } from "@nell/browser/adapters";
import { accessScopeForUser } from "@nell/shared";
import { anthropicSearchProvider } from "@nell/integrations";
import {
  captureTool,
  checkUrl,
  fetchTool,
  imageTool,
  MAX_DOWNLOAD_BYTES,
  searchTool,
  type BrowserFetch,
  type Capability,
  type PageCapture,
} from "@nell/agent";
import { drawerFor, overridesFromEnv } from "./assignment.js";
import { EnvKeyProvider } from "@nell/vault";
import { auditSink, readAudit } from "./audit-store.js";
import { installDurableTasks, shutdownDurableTasks } from "./durable-tasks.js";
import { assertRlsEnforceable, createPool, withWorkspace } from "./db.js";
import { run } from "./nell.js";
import { vaultAccess } from "./vault-secrets.js";
import { startVaultForm } from "./vault-form.js";
import { forgetItem, listItems } from "./vault-store.js";
import { applyMemoryEdits } from "./memory-edit.js";
import { readDirectives, readLedger } from "./memory-store.js";
import { readProfile } from "./profile.js";
import { exportMemory } from "@nell/memory";
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

/**
 * The search vendor, declared before the tools that use it.
 *
 * Reachable with an Anthropic key the way Brave's is reachable with a Brave
 * key, and independent of `NELL_MODEL`: a workspace driving its agent with
 * DeepSeek or a local model still searches through this. That independence is
 * the point — it is what lets searching be offered to every model rather than
 * only to one whose vendor happens to search server-side.
 */
const search = anthropicKey ? anthropicSearchProvider({ apiKey: anthropicKey }) : undefined;

/**
 * What the model may reach for mid-task.
 *
 * `fetch_url` is unconditional: it needs no vendor and no key, only this
 * machine's own internet — which the browser has been using all along. Its
 * absence is why "search the web and download me an image" *generated* one
 * instead. Search returns snippets and the vendor's sandbox is network-isolated,
 * so nothing on the shelf could fetch bytes, and the model did the nearest
 * possible thing rather than saying it could not.
 */
/**
 * The rung above a plain fetch, and the reason it holds none of the user's logins.
 *
 * A model-chosen URL opened on the workspace's own machine would be opened by a
 * browser that is signed into their airline, their bank and their email. The
 * request would carry those cookies, and whatever came back would land in the
 * model's context — a way to read the user's private pages by naming them,
 * which is the shape of every gate in Aegis reversed. So downloads get a
 * **scratch** machine: a fresh profile, no cookies, no identity, discarded when
 * the download ends. It is slower than reusing the warm one, and that is the
 * price of the boundary rather than an oversight.
 *
 * Per-download rather than pooled for the same reason `release` destroys them:
 * a scratch machine that lived across downloads would start accumulating
 * exactly the state it exists not to have.
 */
const scratchHost = new LocalMachineHost({
  root: join(profileRoot, "scratch"),
  headless: process.env["NELL_HEADED"] !== "1",
});

const viaBrowser: BrowserFetch = async (url) => {
  const machine = await scratchHost.provision("downloads", { scratch: true });
  try {
    return await scratchHost.download(machine.id, url, {
      /**
       * The same refusal as the plain fetch, applied to every hop.
       *
       * Chromium follows redirects itself, so without this the check the model
       * already passed would cover only the first request — and a public URL
       * that 302s to the metadata endpoint is the attack this whole file exists
       * to refuse, wearing a hat.
       */
      allow: async (candidate) => (await checkUrl(candidate)).ok,
      maxBytes: MAX_DOWNLOAD_BYTES,
    });
  } finally {
    await scratchHost.destroy(machine.id).catch(() => undefined);
  }
};

/**
 * Which model draws, decided by the admin's assignment rather than by which key
 * happens to be set.
 *
 * `NELL_MODEL_IMAGE=openai/gpt-image-1` moves picture generation to OpenAI while
 * everything else stays on the default model. Unset, it falls to the default
 * model's own vendor if that vendor draws — so a Google-default install keeps
 * working with no configuration, which is where this started.
 *
 * The same resolution feeds `/models`, so the settings answer and the running
 * behaviour are one computation rather than two that can drift.
 */
const assignment = { defaultModel: modelId, overrides: overridesFromEnv(process.env) };
const drawer = drawerFor(assignment, (vendor) =>
  vendor === "google" ? googleKey : vendor === "openai" ? process.env["OPENAI_API_KEY"] : undefined
);

/**
 * Which model does the reasoning, reading, searching and code — the assist path.
 *
 * **It was the literal string `"claude-sonnet-4-5"`**, so `NELL_MODEL` changed
 * which model *browsed* and left every other kind of task on Sonnet. Setting
 * `anthropic/claude-opus-5` and watching nothing change is the sort of bug that
 * never produces an error: the work still happens, on the wrong model, and the
 * only symptom is a bill and a quality difference nobody can attribute.
 *
 * **The limit, stated where it actually falls.** `assist` speaks Anthropic's
 * Messages API today, so a non-Anthropic default cannot serve this path yet and
 * quietly running on Claude anyway would have the settings screen lying about
 * which account is billed. It says so at boot instead of pretending.
 *
 * That limit is an implementation gap and not a property of the design, which is
 * worth being precise about because the two call for different work. Of the four
 * jobs this path does, **three are not vendor features at all**: reasoning and
 * reading are what every model does, and searching is an HTTP call to a search
 * vendor that any model able to call a function can make — which is what
 * `searchTool` is, and why it is supplied to every model rather than only to one
 * that happens to have a server-side searcher. **Running code is the real
 * exception**: a sandbox is not a call we can make on somebody's behalf, and
 * running model-authored code in one we own is a security decision the
 * architecture defers deliberately.
 */
const assist = ((): { apiKey: string; model: string; baseUrl?: string } | undefined => {
  const vendor = assignment.defaultModel.split("/")[0] ?? "";
  const keys = keysFromEnv(process.env);

  const key =
    vendor === "anthropic"
      ? anthropicKey
      : vendor === "openai"
        ? keys.openai
        : vendor === "deepseek"
          ? keys.deepseek
          : vendor === "moonshot"
            ? keys.moonshot
            : vendor === "zhipu"
              ? keys.zhipu
              : vendor === "openrouter"
                ? keys.openrouter
                : vendor === "self-hosted"
                  ? // Local endpoints usually ignore the key; a placeholder is
                    // simpler than making the header conditional.
                    (keys.selfHostedBaseUrl && "not-required") || undefined
                  : undefined;

  if (!key) {
    console.log(
      `note: no key for ${vendor}, so ${assignment.defaultModel} cannot answer questions, read ` +
        `documents or search. Add that vendor's key.`
    );
    return undefined;
  }

  return {
    apiKey: key,
    // The full id, vendor half included: stripping it here is precisely how this
    // path came to speak one vendor while settings described another.
    model: assignment.defaultModel,
    ...(vendor === "self-hosted" && keys.selfHostedBaseUrl
      ? { baseUrl: keys.selfHostedBaseUrl }
      : {}),
  };
})();

/**
 * Looking at a page, on the same machine that holds nothing.
 *
 * A live radar map, a chart, a departures board — the *rendering* is the
 * information and the bytes behind it are a JavaScript bundle. Same scratch
 * machine as the downloader and for the same reason: a model-chosen URL must
 * not be opened by a browser signed into the user's accounts.
 */
const viaScreenshot: PageCapture = async (url, captureOptions) => {
  const machine = await scratchHost.provision("captures", { scratch: true });
  try {
    return await scratchHost.capture(machine.id, url, {
      allow: async (candidate) => (await checkUrl(candidate)).ok,
      ...(captureOptions?.fullPage === true ? { fullPage: true } : {}),
    });
  } finally {
    await scratchHost.destroy(machine.id).catch(() => undefined);
  }
};

const specialists = [
  fetchTool({ viaBrowser }),
  captureTool({ capture: viaScreenshot }),
  /**
   * Search as a tool, not as a vendor feature.
   *
   * Anthropic's server-side search is better where it exists — one request, no
   * snippets crossing this process — and stays on for that vendor. This is the
   * same capability for every other model, and the reason the assist path does
   * not have to be Anthropic-shaped for anything except running code.
   */
  ...(search ? [searchTool({ search: (query) => search.search(query) })] : []),
  ...(drawer
    ? [
        imageTool({
          apiKey: drawer.apiKey,
          vendor: drawer.vendor,
          ...(drawer.model ? { model: drawer.model } : {}),
        }),
      ]
    : []),
];

/**
 * The page a password is typed into, served on loopback.
 *
 * Only started when there is a key to encrypt with — a form that collects
 * credentials and has nowhere to put them is worse than no form.
 */
const form = await startVaultForm({
  pool,
  ...(vaultKeys ? { keys: vaultKeys } : {}),
  /**
   * Reading and editing what Nell believes about you.
   *
   * `parseMemoryMarkdown` has existed since v1 with no caller, so `MEMORY.md`
   * could be read and never corrected — and a memory you cannot correct is one
   * you have to trust rather than check. Served here rather than in the chat
   * because a document is a poor thing to edit one message at a time.
   */
  memory: {
    read: async (scope) =>
      withWorkspace(
        pool,
        scope,
        async (client) =>
          exportMemory({
            workspaceId: scope.workspaceId,
            preferences: await readProfile(client, scope),
            directives: await readDirectives(client, scope),
            entries: await readLedger(client, scope, 50),
            now: Date.now(),
          }).files["MEMORY.md"] ?? ""
      ),
    save: (scope, markdown) => applyMemoryEdits(pool, scope, markdown),
  },
  ...(vaultKeys && vault
    ? {
        // So the form opens with the email already in it and only the password
        // left to type — the part that must be typed there, and the only part.
        knownAccount: vault.knownAccount,
        // The item id and its kind, never the value — an audit log that records
        // secrets is a second copy of the vault with no encryption on it.
        onSaved: (scope, kind, itemId) =>
          audit.record({
            action: "secret.write",
            subject: itemId,
            detail: { kind },
            at: stamp(),
          }),
      }
    : {}),
});
if (vaultKeys) console.log("vault: on");

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
    /**
     * So `/models` describes this install rather than a default one.
     *
     * It has always accepted overrides and never been given any, which made the
     * settings answer accurate about the default model and blind to every
     * per-capability choice an admin had made.
     */
    ...(Object.keys(assignment.overrides).length > 0 ? { assignment: assignment.overrides } : {}),
    ...(assist
      ? {
          assistKey: assist.apiKey,
          assistModel: assist.model,
          ...(assist.baseUrl ? { assistBaseUrl: assist.baseUrl } : {}),
        }
      : {}),
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
    memoryLink: form.memoryLink,
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
await form.close();
await sessions.close();
await browser.shutdown();
await pool.end();
