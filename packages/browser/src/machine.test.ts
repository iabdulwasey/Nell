import { beforeEach, describe, expect, it } from "vitest";
import type { AccessScope } from "@nell/shared";
import {
  IDLE_BEFORE_STANDBY_MS,
  MachineRegistry,
  type ActOutcome,
  type ComputerAction,
  type Downloaded,
  type Machine,
  type MachineHost,
} from "./index.js";

const scopeFor = (workspaceId: string): AccessScope =>
  ({ workspaceId, userId: `user-${workspaceId}` }) as AccessScope;

const alice = scopeFor("ws-alice");
const bob = scopeFor("ws-bob");

/** Records what the backend was asked to do, so the tests assert on lifecycle. */
class FakeHost implements MachineHost {
  provisioned = 0;
  resumed: string[] = [];
  suspended: string[] = [];
  destroyed: string[] = [];
  clock = 1_000_000;
  readonly #state = new Map<string, Machine>();

  async provision(workspaceId: string, options: { readonly scratch: boolean }): Promise<Machine> {
    this.provisioned += 1;
    const machine: Machine = {
      id: `m${String(this.provisioned)}`,
      workspaceId,
      state: "running",
      createdAt: this.clock,
      lastUsedAt: this.clock,
      tasksServed: 0,
      viewport: { width: 1440, height: 900 },
      scratch: options.scratch,
    };
    this.#state.set(machine.id, machine);
    return machine;
  }

  async resume(machineId: string): Promise<Machine> {
    this.resumed.push(machineId);
    const machine = this.#state.get(machineId);
    if (!machine) throw new Error(`no machine ${machineId}`);
    const woken = { ...machine, state: "running" as const };
    this.#state.set(machineId, woken);
    return woken;
  }

  async standby(machineId: string): Promise<void> {
    this.suspended.push(machineId);
  }

  async act(_machineId: string, _action: ComputerAction): Promise<ActOutcome> {
    return { currentOrigin: "https://example.com", currentUrl: "https://example.com/" };
  }

  downloaded: string[] = [];

  async download(_machineId: string, url: string): Promise<Downloaded> {
    this.downloaded.push(url);
    return {
      status: 200,
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      finalUrl: url,
    };
  }

  navigated: string[] = [];

  async navigate(_machineId: string, url: string): Promise<ActOutcome> {
    this.navigated.push(url);
    return { currentOrigin: new URL(url).origin, currentUrl: url };
  }

  async destroy(machineId: string): Promise<void> {
    this.destroyed.push(machineId);
    this.#state.delete(machineId);
  }
}

let host: FakeHost;
let registry: MachineRegistry;

beforeEach(() => {
  host = new FakeHost();
  registry = new MachineRegistry({ host, now: () => host.clock });
});

describe("one machine per user", () => {
  it("provisions a machine the first time a task needs one", async () => {
    const machine = await registry.acquire(alice);
    expect(host.provisioned).toBe(1);
    expect(machine.workspaceId).toBe("ws-alice");
    expect(machine.scratch).toBe(false);
  });

  // The load-bearing invariant. A second machine would split the user's logins
  // in half with no error anywhere.
  it("reuses the same machine for every later task", async () => {
    const first = await registry.acquire(alice);
    await registry.release(first.id);
    const second = await registry.acquire(alice);

    expect(second.id).toBe(first.id);
    expect(host.provisioned).toBe(1);
  });

  it("keeps one user's machine separate from another's", async () => {
    const a = await registry.acquire(alice);
    const b = await registry.acquire(bob);
    expect(a.id).not.toBe(b.id);
    expect(host.provisioned).toBe(2);
  });

  // Two tasks starting at once must not race to create two machines.
  it("holds the invariant under concurrent acquisition", async () => {
    const [a, b, c] = await Promise.all([
      registry.acquire(alice),
      registry.acquire(alice),
      registry.acquire(alice),
    ]);
    expect(host.provisioned).toBe(1);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
  });

  it("counts the tasks a machine has served", async () => {
    await registry.acquire(alice);
    await registry.acquire(alice);
    expect(registry.describe(alice)?.tasksServed).toBe(2);
  });
});

describe("standby", () => {
  it("resumes from standby rather than provisioning again", async () => {
    const first = await registry.acquire(alice);
    await registry.release(first.id);

    host.clock += IDLE_BEFORE_STANDBY_MS + 1;
    expect(await registry.sweepIdle()).toEqual([first.id]);
    expect(registry.describe(alice)?.state).toBe("standby");

    const woken = await registry.acquire(alice);
    expect(host.resumed).toEqual([first.id]);
    expect(host.provisioned).toBe(1);
    expect(woken.state).toBe("running");
  });

  // An idle machine that never suspends is the easiest way for this
  // architecture to quietly cost ten times what it should.
  it("suspends a machine nobody is using", async () => {
    const machine = await registry.acquire(alice);
    await registry.release(machine.id);
    host.clock += IDLE_BEFORE_STANDBY_MS + 1;

    await registry.sweepIdle();
    expect(host.suspended).toEqual([machine.id]);
  });

  it("leaves a machine alone while a task is still attached", async () => {
    await registry.acquire(alice);
    host.clock += IDLE_BEFORE_STANDBY_MS + 1;
    expect(await registry.sweepIdle()).toEqual([]);
  });

  it("leaves a recently used machine warm", async () => {
    const machine = await registry.acquire(alice);
    await registry.release(machine.id);
    host.clock += 1000;
    expect(await registry.sweepIdle()).toEqual([]);
  });

  it("preserves the machine's age across a suspend and wake", async () => {
    const first = await registry.acquire(alice);
    await registry.release(first.id);
    host.clock += IDLE_BEFORE_STANDBY_MS + 1;
    await registry.sweepIdle();
    host.clock += 86_400_000;

    expect((await registry.acquire(alice)).createdAt).toBe(first.createdAt);
  });
});

describe("scratch machines", () => {
  it("never becomes the machine the user's logins live on", async () => {
    const primary = await registry.acquire(alice);
    const scratch = await registry.acquireScratch(alice);

    expect(scratch.id).not.toBe(primary.id);
    expect(scratch.scratch).toBe(true);
    expect(registry.describe(alice)?.id).toBe(primary.id);
  });

  it("is discarded when the task detaches", async () => {
    const scratch = await registry.acquireScratch(alice);
    await registry.release(scratch.id);
    expect(host.destroyed).toEqual([scratch.id]);
  });

  it("does not discard the primary machine on release", async () => {
    const primary = await registry.acquire(alice);
    await registry.release(primary.id);
    expect(host.destroyed).toEqual([]);
    expect(registry.describe(alice)?.id).toBe(primary.id);
  });

  it("is not suspended by the idle sweep — it is already gone or in use", async () => {
    await registry.acquireScratch(alice);
    host.clock += IDLE_BEFORE_STANDBY_MS + 1;
    expect(await registry.sweepIdle()).toEqual([]);
  });
});

describe("destruction is a deletion event", () => {
  it("issues a receipt saying what was thrown away", async () => {
    const machine = await registry.acquire(alice);
    host.clock += 86_400_000 * 30;
    await registry.acquire(alice);

    const receipt = await registry.destroy(alice, "user requested erasure");

    expect(receipt).toMatchObject({
      machineId: machine.id,
      workspaceId: "ws-alice",
      ageMs: 86_400_000 * 30,
      tasksServed: 2,
      reason: "user requested erasure",
    });
    expect(host.destroyed).toEqual([machine.id]);
  });

  it("provisions a genuinely new machine afterwards", async () => {
    const first = await registry.acquire(alice);
    await registry.destroy(alice, "user requested erasure");

    const second = await registry.acquire(alice);
    expect(second.id).not.toBe(first.id);
    expect(second.tasksServed).toBe(1);
    expect(host.provisioned).toBe(2);
  });

  it("reports nothing when there was no machine to destroy", async () => {
    expect(await registry.destroy(alice, "cleanup")).toBeUndefined();
  });
});

describe("what the dashboard shows", () => {
  it("has nothing to show before the first task", () => {
    expect(registry.describe(alice)).toBeUndefined();
  });

  it("reports state, age and work done", async () => {
    await registry.acquire(alice);
    expect(registry.describe(alice)).toMatchObject({
      state: "running",
      tasksServed: 1,
      scratch: false,
    });
  });
});
