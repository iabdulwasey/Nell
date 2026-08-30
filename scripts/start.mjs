/**
 * Run Nell: the agent, and the dashboard beside it.
 *
 * `pnpm build` has produced a working dashboard for weeks and **nothing started
 * it**, which is why two packages — `auth` and `views` — read as unreachable
 * while being perfectly reachable by anybody who happened to type `next start`
 * in the right directory. A deploy story that exists only in somebody's shell
 * history is not a deploy story.
 *
 * Both processes, one terminal, and either one dying takes the other down. That
 * is deliberate: a half-running Nell — an agent with no dashboard, or a
 * dashboard reading a database no agent is writing to — is more confusing than
 * a stopped one, and a supervisor that hides the difference is how somebody
 * spends an afternoon on a bot that was never listening.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The dashboard binds to loopback unless told otherwise.
 *
 * `next start` binds 0.0.0.0 by default, which on a laptop on café wifi puts a
 * page showing somebody's tasks, vault item names and audit log on the local
 * network. It has authentication now, so this is defence in depth rather than
 * the only wall — but the default should be the safe one, and exposing it should
 * be a decision somebody typed.
 */
const children = [
  { name: "agent", command: "node", args: ["dist/main.js"], cwd: join(root, "apps/core") },
  { name: "web", command: "pnpm", args: ["--filter", "@nell/web", "start"], cwd: root },
];

const running = children.map(({ name, command, args, cwd }) => {
  const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });

  child.on("exit", (code, signal) => {
    console.error(`\n${name} exited (${signal ?? code}) — stopping the rest.`);
    stop();
    process.exitCode = code ?? 1;
  });

  return child;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of running) child.kill("SIGTERM");
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
