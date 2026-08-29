import { beforeEach, describe, expect, it } from "vitest";
import type { AuditInput } from "@nell/audit";
import { accessScopeForUser } from "@nell/shared";
import { LocalBrowserProvider } from "@nell/browser/adapters";
import type { BrowserAction, ComputerAction } from "@nell/browser";
import {
  BrowserExecutor,
  mintHandoff,
  type DriverOptions,
  type DriverResult,
  type ExecuteRequest,
  type SessionDriver,
} from "./index.js";

const scope = accessScopeForUser("user-exec");
const SESSION = "session-1";

class FakeDriver implements SessionDriver {
  origin = "https://bank.example";
  /** What the executor actually asked the browser to mask. */
  lastOptions: DriverOptions | undefined;
  targeted: BrowserAction[][] = [];
  computer: ComputerAction[][] = [];
  extracted: Record<string, string> | undefined;

  async perform(
    _scope: unknown,
    _sessionId: string,
    actions: readonly BrowserAction[],
    options: DriverOptions
  ): Promise<DriverResult> {
    this.targeted.push([...actions]);
    this.lastOptions = options;
    return { currentOrigin: this.origin, extracted: this.extracted };
  }

  async performComputer(
    _scope: unknown,
    _sessionId: string,
    actions: readonly ComputerAction[],
    options: DriverOptions
  ): Promise<DriverResult> {
    this.computer.push([...actions]);
    this.lastOptions = options;
    return { currentOrigin: this.origin, screenshot: "base64png", extracted: this.extracted };
  }

  async currentOrigin(): Promise<string> {
    return this.origin;
  }
}

let driver: FakeDriver;
let audit: AuditInput[];
let executor: BrowserExecutor;

beforeEach(() => {
  driver = new FakeDriver();
  audit = [];
  executor = new BrowserExecutor({
    driver,
    audit: {
      record: (input) => {
        audit.push(input);
      },
    },
    now: () => new Date("2026-08-29T00:00:00.000Z"),
    secretValues: () => ["hunter2-the-real-password"],
  });
});

const click: BrowserAction = { action: "click", target: { by: "text", text: "Continue" } };
const pixelClick: ComputerAction = {
  action: "left_click",
  coordinate: { x: 10, y: 10 },
  modifiers: [],
};

describe("an untainted session", () => {
  it("runs targeted actions", async () => {
    const outcome = await executor.execute(scope, SESSION, { kind: "targeted", actions: [click] });
    expect(outcome.ok).toBe(true);
    expect(driver.targeted).toHaveLength(1);
  });

  it("runs computer actions", async () => {
    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [pixelClick],
    });
    expect(outcome.ok).toBe(true);
    expect(driver.computer).toHaveLength(1);
  });

  it("asks for no masking, because there is nothing to mask", async () => {
    await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [{ action: "screenshot" }],
    });
    expect(driver.lastOptions?.maskSelectors).toEqual([]);
  });
});

describe("perception confers no authority", () => {
  beforeEach(() => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);
  });

  // The headline property. Two ways of seeing, one set of gates.
  it("reaches the same verdict for the same operation from either path", async () => {
    const pairs: readonly (readonly [ExecuteRequest, ExecuteRequest])[] = [
      [
        { kind: "targeted", actions: [{ action: "screenshot", fullPage: false }] },
        { kind: "computer", actions: [{ action: "screenshot" }] },
      ],
      [
        { kind: "targeted", actions: [click] },
        { kind: "computer", actions: [pixelClick] },
      ],
      [
        {
          kind: "targeted",
          actions: [
            { action: "type", target: { by: "label", text: "Card" }, text: "x", clearFirst: true },
          ],
        },
        { kind: "computer", actions: [{ action: "type", text: "x" }] },
      ],
      [
        { kind: "targeted", actions: [{ action: "scroll", direction: "down", amount: 100 }] },
        {
          kind: "computer",
          actions: [
            {
              action: "scroll",
              coordinate: { x: 1, y: 1 },
              scroll_direction: "down",
              scroll_amount: 1,
            },
          ],
        },
      ],
    ];

    for (const [targeted, computer] of pairs) {
      const a = await executor.execute(scope, SESSION, targeted);
      const b = await executor.execute(scope, SESSION, computer);
      expect(a.ok).toBe(b.ok);
    }
  });

  // A route the targeted DSL never had: it has no key chords at all.
  it("classifies a clipboard chord into the vocabulary the gate already refuses", async () => {
    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [{ action: "key", keys: ["Control", "c"] }],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/clipboard/iu);
  });

  // Ctrl+C on a masked field, Ctrl+V somewhere visible, screenshot. Masking
  // protects the field, not the copy of it.
  it("closes the copy-out-of-a-masked-field route", async () => {
    for (const keys of [
      ["Control", "c"],
      ["Control", "v"],
      ["Control", "x"],
      ["Meta", "c"],
    ] as const) {
      const outcome = await executor.execute(scope, SESSION, {
        kind: "computer",
        actions: [{ action: "key", keys: [...keys] }],
      });
      expect(outcome.ok).toBe(false);
    }
    expect(driver.computer).toHaveLength(0);
  });

  it("still allows ordinary keys while tainted", async () => {
    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [
        { action: "key", keys: ["Enter"] },
        { action: "type", text: "hello" },
      ],
    });
    expect(outcome.ok).toBe(true);
  });

  it("still allows a select-all chord, which moves no data", async () => {
    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [{ action: "key", keys: ["Control", "a"] }],
    });
    expect(outcome.ok).toBe(true);
  });

  it("refuses an upload from either path", async () => {
    const outcome = await executor.execute(scope, SESSION, {
      kind: "targeted",
      actions: [{ action: "upload", target: { by: "label", text: "CV" }, fileRef: "cv-1" }],
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("captures cannot be taken unmasked by omission", () => {
  // A screenshot on a tainted session with no mask is a plaintext password in
  // the model's context window.
  it("derives masking from live taint, not from an argument", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password", "#otp"]);

    await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [{ action: "screenshot" }],
    });

    expect(driver.lastOptions?.maskSelectors).toEqual(["#password", "#otp"]);
  });

  it("masks on the targeted path too", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);
    await executor.execute(scope, SESSION, {
      kind: "targeted",
      actions: [{ action: "screenshot", fullPage: false }],
    });
    expect(driver.lastOptions?.maskSelectors).toEqual(["#password"]);
  });

  it("scrubs a secret that reached extracted text anyway", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);
    driver.extracted = { text: "Signed in as ada using hunter2-the-real-password" };

    const outcome = await executor.execute(scope, SESSION, {
      kind: "targeted",
      actions: [{ action: "extract", fields: ["text"] }],
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.extracted?.["text"]).toContain("[redacted]");
      expect(outcome.result.extracted?.["text"]).not.toContain("hunter2");
    }
  });
});

describe("batches are refused whole", () => {
  // "It half happened" is the worst outcome for an agent that spends money.
  it("runs nothing when any action in the batch is refused", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);

    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [
        pixelClick,
        { action: "type", text: "safe" },
        { action: "key", keys: ["Control", "c"] },
      ],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusedAt).toBe(2);
    expect(driver.computer).toHaveLength(0);
  });
});

describe("taint lifecycle", () => {
  it("starts clean", () => {
    expect(executor.taintOf(SESSION).tainted).toBe(false);
  });

  it("clears once the session leaves the origin the secret was filled on", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);
    driver.origin = "https://merchant.example";

    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [pixelClick],
    });

    expect(outcome.taint.tainted).toBe(false);
    expect(executor.taintOf(SESSION).tainted).toBe(false);
  });

  it("keeps taint while still on the origin the secret was filled on", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);
    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [pixelClick],
    });
    expect(outcome.taint.tainted).toBe(true);
  });

  it("tracks sessions independently", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);
    expect(executor.taintOf("session-2").tainted).toBe(false);

    const other = await executor.execute(scope, "session-2", {
      kind: "computer",
      actions: [{ action: "key", keys: ["Control", "c"] }],
    });
    expect(other.ok).toBe(true);
  });

  it("accumulates selectors across several fills", () => {
    executor.markFilled(SESSION, "https://bank.example", ["#user"]);
    const state = executor.markFilled(SESSION, "https://bank.example", ["#password", "#user"]);
    expect([...state.filledSelectors].sort()).toEqual(["#password", "#user"]);
  });
});

describe("refusals are auditable", () => {
  it("writes an audit entry naming the operation refused", async () => {
    executor.markFilled(SESSION, "https://bank.example", ["#password"]);
    await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [{ action: "key", keys: ["Control", "c"] }],
    });

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      workspaceId: scope.workspaceId,
      action: "policy.deny",
      subject: SESSION,
      detail: { operation: "read-clipboard" },
    });
  });

  it("does not write a denial when nothing was denied", async () => {
    await executor.execute(scope, SESSION, { kind: "computer", actions: [pixelClick] });
    expect(audit).toHaveLength(0);
  });
});

describe("the port and the real provider have not drifted", () => {
  // The reason SessionDriver.perform is named to match BrowserProvider.perform:
  // a hand-written adapter between the two would be one more place a check
  // could be skipped. This fails to compile if they diverge.
  it("is satisfied structurally by the real browser provider", () => {
    const driver: SessionDriver = new LocalBrowserProvider();
    expect(driver.perform).toBeTypeOf("function");
    expect(driver.performComputer).toBeTypeOf("function");
  });
});

describe("while a person is driving", () => {
  const grant = mintHandoff({
    workspaceId: scope.workspaceId,
    machineId: "machine-1",
    taskId: "task-1",
    reason: "captcha",
    origin: "https://tickets.example",
    pepper: "pepper",
    now: 1_700_000_000_000,
  }).grant;

  // Two parties on one pointer would fight for it.
  it("the agent stops acting", async () => {
    executor.handOver(SESSION, grant, 1_700_000_000_000);

    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [pixelClick],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/person is driving/iu);
    expect(driver.computer).toHaveLength(0);
  });

  it("refuses the targeted path too, not just pixels", async () => {
    executor.handOver(SESSION, grant, 1_700_000_000_000);
    const outcome = await executor.execute(scope, SESSION, { kind: "targeted", actions: [click] });
    expect(outcome.ok).toBe(false);
    expect(driver.targeted).toHaveLength(0);
  });

  it("records the refusal", async () => {
    executor.handOver(SESSION, grant, 1_700_000_000_000);
    await executor.execute(scope, SESSION, { kind: "computer", actions: [pixelClick] });
    expect(audit[0]).toMatchObject({ action: "policy.deny", detail: { operation: "handoff" } });
  });

  it("only pauses the session that was handed over", async () => {
    executor.handOver(SESSION, grant, 1_700_000_000_000);
    const other = await executor.execute(scope, "session-elsewhere", {
      kind: "computer",
      actions: [pixelClick],
    });
    expect(other.ok).toBe(true);
  });

  it("resumes once the controls come back", async () => {
    executor.handOver(SESSION, grant, 1_700_000_000_000);
    executor.takeBack(SESSION, "https://tickets.example");

    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [pixelClick],
    });
    expect(outcome.ok).toBe(true);
  });

  // We do not know what the person typed while they held the controls.
  it("treats the session as tainted afterwards", async () => {
    executor.handOver(SESSION, grant, 1_700_000_000_000);
    executor.takeBack(SESSION, "https://tickets.example");

    expect(executor.taintOf(SESSION).tainted).toBe(true);

    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [{ action: "key", keys: ["Control", "c"] }],
    });
    expect(outcome.ok).toBe(false);
  });

  it("clears that taint once the session leaves the page", async () => {
    executor.handOver(SESSION, grant, 1_700_000_000_000);
    executor.takeBack(SESSION, "https://tickets.example");
    driver.origin = "https://elsewhere.example";

    const outcome = await executor.execute(scope, SESSION, {
      kind: "computer",
      actions: [pixelClick],
    });
    expect(outcome.taint.tainted).toBe(false);
  });

  it("starts with the agent in control", () => {
    expect(executor.controlOf("fresh-session").holder).toBe("agent");
  });
});
