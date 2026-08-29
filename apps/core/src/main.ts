/**
 * Start Nell.
 *
 * Reads configuration from the environment, refuses to start on anything
 * missing, and says which — a process that boots and then silently does nothing
 * is harder to diagnose than one that will not boot.
 */

import { LocalBrowserProvider } from "@nell/browser/adapters";
import { keysFromEnv } from "@nell/agent";
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
    log: (line) => {
      console.log(line);
    },
  },
  controller.signal
);

await sessions.close();
await browser.shutdown();
await pool.end();
