/**
 * Start Nell.
 *
 * Reads configuration from the environment, refuses to start on anything
 * missing, and says which — a process that boots and then silently does nothing
 * is harder to diagnose than one that will not boot.
 */

import { LocalBrowserProvider } from "@nell/browser/adapters";
import { keysFromEnv } from "@nell/agent";
import { anthropicSearchProvider } from "@nell/integrations";
import { assertRlsEnforceable, createPool } from "./db.js";
import { run } from "./nell.js";
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

const browser = new LocalBrowserProvider({ headless: process.env["NELL_HEADED"] !== "1" });
const sessions = new WorkspaceSessions({ provider: browser, startUrl });

/**
 * A search vendor, not a model choice.
 *
 * Reachable with an Anthropic key in the same way Brave's is reachable with a
 * Brave key, and independent of `NELL_MODEL` — a workspace driving its agent
 * with DeepSeek or a local model still searches through this. Absent, the agent
 * still works and simply cannot get past a search engine's captcha.
 */
const anthropicKey = process.env["ANTHROPIC_API_KEY"];
const search = anthropicKey ? anthropicSearchProvider({ apiKey: anthropicKey }) : undefined;

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nstopping");
    controller.abort();
  });
}

console.log(`model: ${modelId}`);
console.log(`owner: telegram ${owner!}`);

await run(
  {
    pool,
    browser,
    keys: keysFromEnv(process.env),
    modelId,
    telegramToken: token!,
    knownSenders: new Map([[owner!, `tg-${owner!}`]]),
    sessions,
    ...(search ? { search } : {}),
    log: (line) => {
      console.log(line);
    },
  },
  controller.signal
);

await sessions.close();
await browser.shutdown();
await pool.end();
