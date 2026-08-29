/**
 * The user's computer.
 *
 * Every workspace owns one long-lived machine. Not one per task, not one per
 * merchant — one, the same one, for as long as the user has an account. Tasks
 * attach to it and detach from it; it outlives all of them.
 *
 * That persistence is the whole point, and it is worth being precise about why,
 * because "cache the cookies" undersells it:
 *
 * - **Logins stay valid.** A task three weeks later opens the airline site
 *   already signed in. No credential is fetched from the vault, so no credential
 *   is exposed, so the most sensitive operation Nell performs simply does not
 *   happen most of the time. Persistence is a security property before it is a
 *   convenience one.
 * - **The device earns trust.** Sites fingerprint the browser and score the
 *   history behind it. A machine that has shopped somewhere for months looks
 *   like a returning customer; a fresh container looks like a bot, and gets
 *   treated like one — CAPTCHAs, step-up 2FA, holds. The single most effective
 *   anti-bot measure available is not evading detection, it is being a real
 *   returning user. A persistent machine is that, honestly.
 * - **Cost.** Provisioning is the expensive part of a browser's life. An idle
 *   machine on standby holds its disk and costs a fraction of a running one, so
 *   the compounding asset is also the cheap option.
 *
 * The machine is user data. It holds their sessions and their downloads, so
 * destroying it is a deletion event with a receipt, never a cleanup detail.
 */

import type { AccessScope } from "@nell/shared";
import type { ComputerAction, DisplaySize } from "./computer.js";

/**
 * - `running`  — warm, attached, billed at full rate.
 * - `standby`  — suspended; disk, cookies and profile intact; cheap.
 * - `stopped`  — deliberately shut down; disk still intact, slower to wake.
 * - `destroyed`— disk gone. Terminal, and only ever user-initiated.
 */
export type MachineState = "running" | "standby" | "stopped" | "destroyed";

export interface Machine {
  readonly id: string;
  readonly workspaceId: string;
  readonly state: MachineState;
  /** When this machine was first provisioned — its age IS its accrued trust. */
  readonly createdAt: number;
  readonly lastUsedAt: number;
  /** Tasks this machine has served since it was created. */
  readonly tasksServed: number;
  /** URL a human can open to watch, or to take over a CAPTCHA. */
  readonly liveViewUrl?: string;
  /** Resolution the machine renders at. */
  readonly viewport: DisplaySize;
  /**
   * Scratch machines are for work that must not touch the user's identity — a
   * second account, an anonymous price check, a login that would evict theirs.
   * They are discarded after the task, and never become the workspace machine.
   */
  readonly scratch: boolean;
}

export interface ActOutcome {
  /** Base64 PNG of the screen after the action. */
  readonly screenshot?: string;
  /** Origin the machine is on now. The origin gate reads this, not the model. */
  readonly currentOrigin: string;
  /**
   * The full URL. A worker driving by pixels needs to know which page it is on
   * and cannot read it off a screenshot: a headless machine renders the page,
   * not the browser's own chrome, so there is no address bar in the image.
   */
  readonly currentUrl: string;
  readonly cursor?: { readonly x: number; readonly y: number };
}

/**
 * What a hosting backend must provide. A cloud vendor implements this; so does
 * a local Chromium sidecar, which is why self-host is the same product and not a
 * degraded one.
 */
export interface MachineHost {
  provision(workspaceId: string, options: { readonly scratch: boolean }): Promise<Machine>;
  /** Wake a suspended machine. Must preserve cookies, profile and disk. */
  resume(machineId: string): Promise<Machine>;
  /** Suspend without losing state. */
  standby(machineId: string): Promise<void>;
  act(machineId: string, action: ComputerAction): Promise<ActOutcome>;

  /**
   * Open a URL.
   *
   * Navigation has to be an operation rather than something the model types
   * into an address bar, because a headless machine has no address bar to type
   * into. Restricted to http(s) for the same reason the targeted DSL is:
   * `javascript:`, `data:` and `file:` turn a navigation into code execution or
   * local-file access.
   */
  navigate(machineId: string, url: string): Promise<ActOutcome>;
  /** Irreversible. Disk and all sessions on it are gone. */
  destroy(machineId: string): Promise<void>;
}

/** How long a machine sits warm after its last use before suspending. */
export const IDLE_BEFORE_STANDBY_MS = 5 * 60 * 1000;

export interface RegistryOptions {
  readonly host: MachineHost;
  /** Injected so idle behaviour is testable without waiting five minutes. */
  readonly now?: () => number;
  readonly idleBeforeStandbyMs?: number;
}

export interface DestroyReceipt {
  readonly machineId: string;
  readonly workspaceId: string;
  /** How long the machine had existed. The trust that is being thrown away. */
  readonly ageMs: number;
  readonly tasksServed: number;
  readonly destroyedAt: number;
  readonly reason: string;
}

/**
 * Owns the mapping from workspace to machine.
 *
 * In-memory here; the durable record lives in Postgres alongside everything
 * else. The invariant this enforces is the load-bearing one: **a workspace has
 * at most one non-scratch machine, ever**. Accidentally provisioning a second
 * would silently split a user's identity in half — half their logins on one
 * machine, half on the other, with no error anywhere and a "why am I logged out"
 * that is close to undebuggable.
 */
export class MachineRegistry {
  readonly #host: MachineHost;
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #machines = new Map<string, Machine>();
  /** workspaceId → machineId, for the primary machine only. */
  readonly #primary = new Map<string, string>();
  /** Machines currently attached to a task, and therefore not idle. */
  readonly #attached = new Map<string, number>();
  /** Serialises concurrent acquires so two tasks cannot both provision. */
  readonly #pending = new Map<string, Promise<Machine>>();

  constructor(options: RegistryOptions) {
    this.#host = options.host;
    this.#now = options.now ?? (() => Date.now());
    this.#idleMs = options.idleBeforeStandbyMs ?? IDLE_BEFORE_STANDBY_MS;
  }

  /**
   * Get the workspace's machine, ready to drive.
   *
   * Provisions it the first time, resumes it from standby every time after. Two
   * tasks starting at once share one machine rather than racing to create two —
   * the pending map is what makes "at most one" hold under concurrency, not just
   * in the happy path.
   */
  async acquire(scope: AccessScope): Promise<Machine> {
    const existing = this.#pending.get(scope.workspaceId);
    if (existing) return existing;

    const work = this.#acquire(scope).finally(() => {
      this.#pending.delete(scope.workspaceId);
    });
    this.#pending.set(scope.workspaceId, work);
    return work;
  }

  async #acquire(scope: AccessScope): Promise<Machine> {
    const id = this.#primary.get(scope.workspaceId);
    const known = id ? this.#machines.get(id) : undefined;

    if (known && known.state !== "destroyed") {
      const ready =
        known.state === "running"
          ? known
          : { ...(await this.#host.resume(known.id)), scratch: false };
      return this.#track(scope.workspaceId, {
        ...ready,
        state: "running",
        lastUsedAt: this.#now(),
        tasksServed: known.tasksServed + 1,
      });
    }

    const fresh = await this.#host.provision(scope.workspaceId, { scratch: false });
    this.#primary.set(scope.workspaceId, fresh.id);
    return this.#track(scope.workspaceId, {
      ...fresh,
      scratch: false,
      state: "running",
      createdAt: fresh.createdAt || this.#now(),
      lastUsedAt: this.#now(),
      tasksServed: 1,
    });
  }

  /**
   * A throwaway machine for work that must not touch the user's identity.
   *
   * Never registered as the workspace's primary, so it cannot accidentally
   * become the machine their logins live on.
   */
  async acquireScratch(scope: AccessScope): Promise<Machine> {
    const machine = await this.#host.provision(scope.workspaceId, { scratch: true });
    return this.#track(scope.workspaceId, {
      ...machine,
      scratch: true,
      state: "running",
      createdAt: machine.createdAt || this.#now(),
      lastUsedAt: this.#now(),
    });
  }

  /**
   * Detach a task. Scratch machines die here; the primary machine does not —
   * it goes idle and is suspended later by the sweep.
   */
  async release(machineId: string): Promise<void> {
    const machine = this.#machines.get(machineId);
    if (!machine) return;

    this.#attached.delete(machineId);
    this.#machines.set(machineId, { ...machine, lastUsedAt: this.#now() });

    if (machine.scratch) {
      await this.#host.destroy(machineId);
      this.#machines.delete(machineId);
    }
  }

  /**
   * Suspend machines nobody is using. Run on the same cron as everything else.
   *
   * Returns what it suspended so the caller can meter it — an idle machine that
   * never reaches standby is the single easiest way for this architecture to
   * quietly cost ten times what it should.
   */
  async sweepIdle(): Promise<readonly string[]> {
    const cutoff = this.#now() - this.#idleMs;
    const suspended: string[] = [];

    for (const machine of [...this.#machines.values()]) {
      if (machine.state !== "running" || machine.scratch) continue;
      if (this.#attached.has(machine.id)) continue;
      if (machine.lastUsedAt > cutoff) continue;

      await this.#host.standby(machine.id);
      this.#machines.set(machine.id, { ...machine, state: "standby" });
      suspended.push(machine.id);
    }

    return suspended;
  }

  /**
   * Destroy the workspace's machine and everything on it.
   *
   * Deliberately awkward to reach and receipted: this throws away every login
   * the machine had accumulated and every day of device trust behind them. It is
   * the right thing to do when a user asks to be forgotten, and the wrong thing
   * to do as error recovery.
   */
  async destroy(scope: AccessScope, reason: string): Promise<DestroyReceipt | undefined> {
    const id = this.#primary.get(scope.workspaceId);
    const machine = id ? this.#machines.get(id) : undefined;
    if (!machine) return undefined;

    await this.#host.destroy(machine.id);
    this.#machines.set(machine.id, { ...machine, state: "destroyed" });
    this.#primary.delete(scope.workspaceId);
    this.#attached.delete(machine.id);

    const destroyedAt = this.#now();
    return {
      machineId: machine.id,
      workspaceId: machine.workspaceId,
      ageMs: destroyedAt - machine.createdAt,
      tasksServed: machine.tasksServed,
      destroyedAt,
      reason,
    };
  }

  /** What the dashboard shows: state, age, and what it has done. */
  describe(scope: AccessScope): Machine | undefined {
    const id = this.#primary.get(scope.workspaceId);
    return id ? this.#machines.get(id) : undefined;
  }

  #track(workspaceId: string, machine: Machine): Machine {
    const owned: Machine = { ...machine, workspaceId };
    this.#machines.set(owned.id, owned);
    this.#attached.set(owned.id, this.#now());
    return owned;
  }
}
