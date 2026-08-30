/**
 * Handing the controls to the person, on a machine with no cloud live view.
 *
 * `@nell/aegis` has had the whole handoff policy since v1 — a grant is 32 random
 * bytes stored as a peppered hash, single-use, minutes-long, bound to one
 * workspace, one machine and one stated reason, revocable, and the executor
 * **refuses every action while a human holds the session**. It was called by
 * nothing but its own tests: the tenth thing in this repository found built,
 * tested and never once run.
 *
 * It stayed unreachable for a concrete reason rather than an oversight. The
 * design assumes a cloud browser with a live-view URL, and a local Chromium has
 * none — there is no page to open on your phone. So the capability read as
 * "blocked on a vendor account", and meanwhile the agent said, out loud, to real
 * users: *"if you open it yourself I can carry on from where you get to"* — a
 * sentence describing a feature that could not be reached.
 *
 * **A live view is a screenshot and a click, and both already exist here.** The
 * machine can be photographed and can be clicked at a coordinate, which is what
 * computer use is. So this serves the picture on loopback and forwards what the
 * person does back onto the real browser. Not a substitute for a vendor's live
 * view — it is one, built out of two things the machine could already do.
 *
 * **The link is a session takeover.** Whoever opens it drives a browser signed
 * into the user's accounts, which is why the token rules above are not
 * ceremony — and why this refuses anything that is not loopback, exactly as the
 * vault form does. On this machine, at this desk, for the ninety seconds it
 * takes to clear a CAPTCHA.
 */

import type { AccessScope } from "@nell/shared";
import type { BrowserProvider, ComputerAction } from "@nell/browser";

/** What the page needs from the machine. Narrow on purpose. */
export interface HandoffMachine {
  screenshot(): Promise<string | undefined>;
  act(action: ComputerAction): Promise<void>;
  size(): { readonly width: number; readonly height: number };
}

/**
 * Narrows a live browse session down to "look and touch".
 *
 * The **same session the task was using**, which is the point: the person is
 * clearing a wall the agent hit, on the page it hit it on, in a browser already
 * carrying whatever cookies got it that far. A fresh browser would land them on
 * a login screen and solve nothing.
 *
 * Deliberately **not** routed through the policy executor. That gate exists to
 * constrain the *agent*, and while a human holds the session it refuses
 * everything by design — which is correct, and would also refuse the human. The
 * authority here is the person at the keyboard.
 *
 * What the page gets is two verbs. There is no navigate and no way to reach the
 * rest of the provider: somebody clearing a CAPTCHA needs to see and to touch,
 * and handing the page a whole browser would be handing it capabilities nobody
 * asked for.
 */
export function handoffMachine(
  driver: BrowserProvider,
  scope: AccessScope,
  sessionId: string
): HandoffMachine {
  return {
    screenshot: async () => {
      const outcome = await driver
        .performComputer(scope, sessionId, [{ action: "screenshot" }])
        .catch(() => undefined);
      return outcome?.screenshot;
    },
    act: async (action) => {
      await driver.performComputer(scope, sessionId, [action]).catch(() => undefined);
    },
    size: () => driver.coordinateSpace().viewport,
  };
}

/**
 * The page the person opens.
 *
 * Deliberately one file with no build step and no framework: it is served on
 * loopback for ninety seconds to somebody who is mid-task and mildly annoyed.
 * It polls a screenshot and posts clicks and keystrokes back.
 *
 * Coordinates are scaled on the *server* side of the click, from the natural
 * size the image reports, so a person on a small window clicks where they think
 * they are clicking. Doing it in the page would put a correctness detail in the
 * one place that is hardest to test.
 */
export function handoffPage(token: string, reason: string, site: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Take over — ${escapeHtml(site)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font:15px/1.5 system-ui,sans-serif; background:#111; color:#eee; }
  header { padding:12px 16px; background:#1c1c1c; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; font-weight:600; }
  .why { color:#aaa; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:0; background:#2d6; color:#052; font-weight:600; cursor:pointer; }
  #shot { display:block; max-width:100%; cursor:crosshair; }
  #done { padding:24px 16px; display:none; }
</style>
<header>
  <h1>You're driving ${escapeHtml(site)}</h1>
  <span class="why">${escapeHtml(reason)}</span>
  <button id="finish">I'm done — carry on</button>
</header>
<img id="shot" alt="The browser, live">
<div id="done">Thanks — handed back. You can close this.</div>
<script>
const token = ${JSON.stringify(token)};
const shot = document.getElementById("shot");
let live = true;

async function refresh() {
  if (!live) return;
  try {
    const r = await fetch("/h/" + token + "/shot", { cache: "no-store" });
    if (r.ok) shot.src = "data:image/png;base64," + (await r.text());
  } catch {}
  setTimeout(refresh, 900);
}
refresh();

/** Where on the real page this click landed, in the image's own pixels. */
function at(event) {
  const box = shot.getBoundingClientRect();
  return {
    x: Math.round((event.clientX - box.left) * (shot.naturalWidth / box.width)),
    y: Math.round((event.clientY - box.top) * (shot.naturalHeight / box.height)),
  };
}

const send = (body) =>
  fetch("/h/" + token + "/act", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

shot.addEventListener("click", (event) => {
  const point = at(event);
  void send({ do: "click", x: point.x, y: point.y });
});

// Typing goes to whatever the last click focused, which is how a browser works.
window.addEventListener("keydown", (event) => {
  if (!live || event.target.tagName === "BUTTON") return;
  if (event.key.length === 1) void send({ do: "type", text: event.key });
  else if (["Enter", "Tab", "Backspace", "Escape"].includes(event.key))
    void send({ do: "key", key: event.key });
  else return;
  event.preventDefault();
});

document.getElementById("finish").addEventListener("click", async () => {
  live = false;
  await send({ do: "finish" });
  document.querySelector("header").style.display = "none";
  shot.style.display = "none";
  document.getElementById("done").style.display = "block";
});
</script>`;
}

/** What the page can ask for. Anything else is refused rather than ignored. */
export type HandoffCommand =
  | { readonly do: "click"; readonly x: number; readonly y: number }
  | { readonly do: "type"; readonly text: string }
  | { readonly do: "key"; readonly key: string }
  | { readonly do: "finish" };

/**
 * Read a command from the page, or refuse it.
 *
 * The page is served by this process to this machine, and is still not trusted
 * to send well-formed input: a parser that assumes its own client is a parser
 * that breaks the first time somebody curls it.
 */
export function readCommand(body: unknown): HandoffCommand | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;

  switch (record["do"]) {
    case "click": {
      const x = record["x"];
      const y = record["y"];
      // Non-finite or negative coordinates are a bug or an attack; either way
      // the machine should not be asked to click at NaN.
      if (typeof x !== "number" || typeof y !== "number") return undefined;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return undefined;
      return { do: "click", x: Math.round(x), y: Math.round(y) };
    }
    case "type": {
      const text = record["text"];
      // One keystroke at a time, which is what the page sends. A long string
      // here would be a paste nobody watched being typed.
      if (typeof text !== "string" || text.length === 0 || text.length > 8) return undefined;
      return { do: "type", text };
    }
    case "key": {
      const key = record["key"];
      const allowed = ["Enter", "Tab", "Backspace", "Escape"];
      if (typeof key !== "string" || !allowed.includes(key)) return undefined;
      return { do: "key", key };
    }
    case "finish":
      return { do: "finish" };
    default:
      return undefined;
  }
}

/** Turn a command into the machine action it means. `finish` is the caller's. */
export function actionFor(command: HandoffCommand): ComputerAction | undefined {
  switch (command.do) {
    case "click":
      // No modifiers: the page sends a plain click, and a handoff that could
      // synthesise Ctrl or Meta would be a wider capability than "touch the screen".
      return { action: "left_click", coordinate: { x: command.x, y: command.y }, modifiers: [] };
    case "type":
      return { action: "type", text: command.text };
    case "key":
      // The key vocabulary is a closed set in the DSL, and these four are the
      // ones `readCommand` admits — so the cast is safe by construction rather
      // than by hope, and a fifth would fail to compile here.
      return { action: "key", keys: [command.key as "Enter" | "Tab" | "Backspace" | "Escape"] };
    case "finish":
      return undefined;
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
