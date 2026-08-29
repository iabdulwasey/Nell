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
  type Target,
} from "@nell/browser";
import { askBeforeSpending, commitsMoney } from "./commits-money.js";
import {
  AGENT_IN_CONTROL,
  handOverControl,
  takeBackControl,
  type ControlState,
  type HandoffGrant,
} from "./handoff.js";
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

  /**
   * The visible label of what a click would hit.
   *
   * Required, not optional. An optional method here would be a gate any adapter
   * could switch off by not implementing it — and this codebase has already
   * shipped one gate that failed open by omission, which is not a mistake worth
   * making twice in the same repository.
   *
   * A driver that cannot answer should return an empty string rather than
   * throw. Unreadable is treated as not-a-purchase, deliberately: a gate that
   * refuses everything it cannot read refuses every click on a page it cannot
   * read, and that is a broken agent rather than a safe one.
   */
  labelOf(
    scope: AccessScope,
    sessionId: string,
    target:
      | { readonly kind: "target"; readonly target: Target }
      | {
          readonly kind: "point";
          readonly x: number;
          readonly y: number;
        }
  ): Promise<string>;
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
      /**
       * Set when the refusal is "a person must say yes", rather than "this is not
       * allowed". The caller shows it to the user instead of reporting a failure.
       */
      readonly needsApproval?: boolean;
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
  readonly #control = new Map<string, ControlState>();

  constructor(options: ExecutorOptions) {
    this.#driver = options.driver;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
    this.#secretValues = options.secretValues ?? (() => []);
  }

  taintOf(sessionId: string): TaintState {
    return this.#taint.get(sessionId) ?? UNTAINTED;
  }

  controlOf(sessionId: string): ControlState {
    return this.#control.get(sessionId) ?? AGENT_IN_CONTROL;
  }

  /** Give the controls to the person. The agent stops acting until they finish. */
  handOver(sessionId: string, grant: HandoffGrant, now: number): ControlState {
    const state = handOverControl(grant, now);
    this.#control.set(sessionId, state);
    return state;
  }

  /**
   * Take the controls back.
   *
   * The session is marked tainted for the handoff origin, because we do not know
   * what the person did while they held it — they may have typed a password or a
   * one-time code. That blocks the mechanical ways a secret could be carried
   * back to the model: field-value reads, the clipboard, downloads and uploads,
   * until the session navigates away.
   *
   * It does NOT stop the agent screenshotting a secret still visible on screen,
   * and cannot, because the agent must be able to see in order to continue. In
   * practice the browser covers the common case for us — a password field
   * renders as dots, so what is on screen is already not the secret — and a
   * one-time code is single-use and near-expired by the time it is on screen.
   * Stated here rather than left as an assumption.
   */
  takeBack(sessionId: string, origin: string): ControlState {
    const state = takeBackControl();
    this.#control.set(sessionId, state);

    const current = this.taintOf(sessionId);
    this.#taint.set(sessionId, {
      tainted: true,
      origin,
      filledSelectors: current.filledSelectors,
    });
    return state;
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
   * Purchases the user has said yes to, by the exact label they were shown.
   *
   * Session-scoped and consumed on use, so an approval buys one click and does
   * not linger for the next page that happens to have a Pay button.
   */
  readonly #approved = new Map<string, string>();

  /**
   * The user said yes.
   *
   * Takes the label they were shown rather than a bare "approved", so consent
   * cannot be transferred to a different button — including the same button
   * after the total on it has changed.
   */
  approveSpend(sessionId: string, label: string): void {
    this.#approved.set(sessionId, label.trim().replaceAll(/\s+/gu, " ").slice(0, 200));
  }

  /** Withdraw an approval that was never used. */
  revokeSpend(sessionId: string): void {
    this.#approved.delete(sessionId);
  }

  /**
   * Whether anything in this batch commits money without an approval.
   *
   * Returns the sentence to send the user, or undefined to proceed. Only clicks
   * are examined: nothing else in either vocabulary can complete a purchase, and
   * asking the page about every scroll would cost a round trip per step for
   * nothing.
   */
  async #spendCheck(
    scope: AccessScope,
    sessionId: string,
    request: ExecuteRequest
  ): Promise<string | undefined> {
    // An approval already granted for this session covers this batch. The token
    // itself is single-use and payload-bound; this is only the question of
    // whether one is present.
    const approved = this.#approved.get(sessionId);

    const clicks: (
      | { readonly kind: "target"; readonly target: Target }
      | {
          readonly kind: "point";
          readonly x: number;
          readonly y: number;
        }
    )[] = [];

    if (request.kind === "targeted") {
      for (const action of request.actions) {
        if (action.action === "click") clicks.push({ kind: "target", target: action.target });
        if (action.action === "click-at") {
          clicks.push({ kind: "point", x: action.x, y: action.y });
        }
      }
    } else {
      for (const action of request.actions) {
        if (
          action.action === "left_click" ||
          action.action === "double_click" ||
          action.action === "triple_click"
        ) {
          clicks.push({ kind: "point", x: action.coordinate.x, y: action.coordinate.y });
        }
      }
    }

    for (const click of clicks) {
      // A driver that cannot read the page returns "", which is not a purchase.
      // Stated in the port: unreadable must not mean unusable.
      const label = await this.#driver.labelOf(scope, sessionId, click).catch(() => "");
      const verdict = commitsMoney(label);
      if (!verdict.commits) continue;

      /**
       * The approval is bound to the label, and consumed by using it.
       *
       * Saying yes to "Pay £18.50" is not saying yes to "Pay £95.00", and a
       * page can change between the question and the answer — that is one of
       * the attacks the payload-bound token was built for. This is the same
       * idea at the only granularity a click has: the words on the button.
       *
       * Weaker than the itemised payload hash, and worth naming as such. The
       * strong version needs an itemised total, which a click does not carry;
       * where one exists — a virtual card issued against an approved payload —
       * that is the guarantee, and this is the gate in front of it.
       */
      if (approved !== undefined && approved === (verdict.label ?? label)) {
        this.#approved.delete(sessionId);
        continue;
      }

      return askBeforeSpending(verdict.label ?? label);
    }

    return undefined;
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

    // Two parties on one pointer would fight for it, and the agent would be
    // acting inside a state the person authenticated and policy never saw.
    const control = this.controlOf(sessionId);
    if (control.holder === "human") {
      const reason = "A person is driving this session — waiting for them to finish.";
      await this.#deny(scope, sessionId, "handoff", reason);
      return { ok: false, reason, refusedAt: 0, taint };
    }

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

    /**
     * The click that spends the money.
     *
     * Checked here, before anything runs, because here is the only place both
     * senses pass through — a pixel click at a coordinate and a targeted click
     * on a ref reach this same line, and a gate that only covered one of them
     * would be a gate the agent could walk around by changing how it sees.
     *
     * The spend machinery has existed since Phase 0 and nothing ever called it.
     * What actually stopped a live booking at the payment page was the model
     * saying it should stop — obedience, which is the one thing this file exists
     * to not depend on.
     *
     * A refusal is not a failure: it is the task arriving at the point where a
     * person has to say yes.
     */
    const spend = await this.#spendCheck(scope, sessionId, request);
    if (spend) {
      await this.#deny(scope, sessionId, "click", spend);
      return { ok: false, reason: spend, refusedAt: 0, taint, needsApproval: true };
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
