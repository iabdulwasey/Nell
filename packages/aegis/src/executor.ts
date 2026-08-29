/**
 * The chokepoint.
 *
 * Everything else in this package is a primitive — a taint machine, an origin
 * check, a spend gate. This file is what composes them, and it matters because a
 * primitive nobody calls enforces nothing. The security model says "the tool
 * executor IS the boundary"; this is that executor, and the only way for a
 * worker to touch a browser session is through it.
 *
 * The property it exists to guarantee: **how the agent sees confers no authority
 * over what it may do.** A worker drives a session two ways — by naming elements
 * (refs) or by acting on pixels (computer use) — and a reasonable-looking
 * implementation would route those down separate paths, because they are
 * genuinely different mechanisms. That is the mistake. Two paths means two sets
 * of checks, which drift, and the weaker one becomes the way around the
 * stronger. Here both kinds are classified into one vocabulary and pass one set
 * of gates, so a pixel click and a targeted click are indistinguishable to
 * policy by construction rather than by discipline.
 */

import type { AuditAction, AuditInput } from "@nell/audit";
import type { AccessScope } from "@nell/shared";
import {
  operationClassOf,
  operationClassOfComputerAction,
  type BrowserAction,
  type ComputerAction,
} from "@nell/browser";
import {
  authorizeOperation,
  afterNavigation,
  scrubSecrets,
  UNTAINTED,
  type TaintState,
} from "./taint.js";

/**
 * What the executor needs a browser to do. Deliberately narrower than the full
 * provider: the executor cannot create sessions, cannot destroy them, and cannot
 * fill a credential — those live on other paths with their own gates, and
 * widening this port would quietly widen what a compromised worker can reach.
 */
export interface SessionDriver {
  /**
   * Named to match `BrowserProvider`, so a provider satisfies this port
   * structurally. A hand-written adapter between the two would be one more
   * place a check could be skipped.
   */
  perform(
    scope: AccessScope,
    sessionId: string,
    actions: readonly BrowserAction[],
    options: DriverOptions
  ): Promise<DriverResult>;

  performComputer(
    scope: AccessScope,
    sessionId: string,
    actions: readonly ComputerAction[],
    options: DriverOptions
  ): Promise<DriverResult>;

  currentOrigin(scope: AccessScope, sessionId: string): Promise<string>;
}

export interface DriverOptions {
  /**
   * Selectors holding filled secrets, which must be visually masked before any
   * capture leaves the machine.
   *
   * The executor always passes the live taint state here. It is not an opt-in a
   * caller can forget: a screenshot taken with this empty on a tainted session
   * is a plaintext password in the model's context window.
   */
  readonly maskSelectors: readonly string[];
}

export interface DriverResult {
  readonly currentOrigin: string;
  readonly extracted?: Record<string, string>;
  readonly screenshot?: string;
  readonly cursor?: { readonly x: number; readonly y: number };
}

/** A batch to run, in whichever way the worker chose to see. */
export type ExecuteRequest =
  | { readonly kind: "targeted"; readonly actions: readonly BrowserAction[] }
  | { readonly kind: "computer"; readonly actions: readonly ComputerAction[] };

export type ExecuteOutcome =
  | { readonly ok: true; readonly result: DriverResult; readonly taint: TaintState }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Index of the action that was refused, so the worker can retry the rest. */
      readonly refusedAt: number;
      readonly taint: TaintState;
    };

export interface AuditSink {
  record(input: AuditInput): Promise<void> | void;
}

export interface ExecutorOptions {
  readonly driver: SessionDriver;
  readonly audit?: AuditSink;
  /** Injected so audit timestamps are deterministic in tests. */
  readonly now?: () => Date;
  /**
   * Live secret values, for scrubbing extracted text. Supplied by the vault-fill
   * path, never by the model.
   */
  readonly secretValues?: () => readonly string[];
}

/**
 * Runs browser work under policy.
 *
 * Taint is held per session here rather than passed in by callers. A caller that
 * has to remember to thread the taint state through is a caller that will
 * eventually forget, and forgetting looks exactly like everything working.
 */
export class BrowserExecutor {
  readonly #driver: SessionDriver;
  readonly #audit: AuditSink | undefined;
  readonly #now: () => Date;
  readonly #secretValues: () => readonly string[];
  readonly #taint = new Map<string, TaintState>();

  constructor(options: ExecutorOptions) {
    this.#driver = options.driver;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
    this.#secretValues = options.secretValues ?? (() => []);
  }

  taintOf(sessionId: string): TaintState {
    return this.#taint.get(sessionId) ?? UNTAINTED;
  }

  /** Record that the vault filled a credential into this session. */
  markFilled(sessionId: string, origin: string, selectors: readonly string[]): TaintState {
    const next: TaintState = {
      tainted: true,
      origin,
      filledSelectors: [...new Set([...this.taintOf(sessionId).filledSelectors, ...selectors])],
    };
    this.#taint.set(sessionId, next);
    return next;
  }

  /**
   * Execute a batch under policy.
   *
   * Every action is authorized before ANY action runs. A batch is refused whole
   * rather than part-way: discovering the refusal three clicks into a checkout
   * leaves the page in a state neither the worker nor the user can reason about,
   * and "it half happened" is the worst possible outcome for an agent that
   * spends money.
   */
  async execute(
    scope: AccessScope,
    sessionId: string,
    request: ExecuteRequest
  ): Promise<ExecuteOutcome> {
    const taint = this.taintOf(sessionId);

    const classes =
      request.kind === "targeted"
        ? request.actions.map((action) => operationClassOf(action))
        : request.actions.map((action) => operationClassOfComputerAction(action));

    for (const [index, operation] of classes.entries()) {
      const decision = authorizeOperation(taint, operation);
      if (decision.allowed) continue;

      await this.#deny(scope, sessionId, operation, decision.reason);
      return { ok: false, reason: decision.reason, refusedAt: index, taint };
    }

    // Masking is derived from live taint, never from a caller's argument, so a
    // capture cannot be taken unmasked by omission.
    const options: DriverOptions = { maskSelectors: taint.filledSelectors };

    const result =
      request.kind === "targeted"
        ? await this.#driver.perform(scope, sessionId, request.actions, options)
        : await this.#driver.performComputer(scope, sessionId, request.actions, options);

    // Belt and braces behind the blocked read paths: even if a secret reaches
    // page text through some route we did not anticipate, it is replaced before
    // the model sees it.
    const scrubbed = taint.tainted ? this.#scrub(result) : result;

    const next = afterNavigation(taint, result.currentOrigin);
    this.#taint.set(sessionId, next);

    return { ok: true, result: scrubbed, taint: next };
  }

  #scrub(result: DriverResult): DriverResult {
    const secrets = this.#secretValues();
    if (secrets.length === 0 || !result.extracted) return result;

    const extracted = Object.fromEntries(
      Object.entries(result.extracted).map(([key, value]) => [key, scrubSecrets(value, secrets)])
    );
    return { ...result, extracted };
  }

  async #deny(
    scope: AccessScope,
    sessionId: string,
    operation: string,
    reason: string
  ): Promise<void> {
    const action: AuditAction = "policy.deny";
    await this.#audit?.record({
      workspaceId: scope.workspaceId,
      action,
      subject: sessionId,
      detail: { operation, reason },
      at: this.#now().toISOString(),
    });
  }
}
