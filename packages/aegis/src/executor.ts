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
  markFilled,
  scrubSecrets,
  UNTAINTED,
  type TaintState,
} from "./taint.js";

/**
 * Stands in for a field that could not be marked.
 *
 * A selector nothing matches, on purpose. It cannot mask anything — it is not
 * meant to — but it keeps the session tainted and the filled-selector list
 * non-empty, so every downstream check that asks "is there a secret on this
 * page" still says yes. Silently recording no selector would leave the session
 * looking clean while a password sat in a field.
 */
const UNMASKABLE = "[data-nell-filled='unknown']";

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
   * Type a secret into a field, after this layer has decided it may.
   *
   * Returns a selector for the field so captures can mask it from here on. An
   * empty selector means the field could not be marked, and the caller must
   * treat that as "this cannot be masked" — a filled password with nothing to
   * mask is one that appears in every screenshot afterwards.
   */
  fillSecret(
    scope: AccessScope,
    sessionId: string,
    target: Target,
    value: string
  ): Promise<{ readonly selector: string }>;

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

/**
 * Where stored credentials come from.
 *
 * A port rather than a dependency: the vault lives in the application, this
 * package is policy, and inverting that would make the security layer depend on
 * the thing it is guarding.
 *
 * The contract is the whole point. `reveal` is given the origin the browser is
 * **actually** on — read from the live session by this file, never supplied by a
 * caller and never by the model — and it must refuse unless the item's own
 * allowlist contains it. FreeInstinct let the model name the origin it expected,
 * which turns an allowlist into a suggestion: a page that persuades the agent it
 * is the bank is handed the bank's password.
 */
export interface SecretSource {
  reveal(
    scope: AccessScope,
    itemId: string,
    actualOrigin: string,
    field: string
  ): Promise<
    { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string }
  >;
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
  /**
   * The vault, if this deployment has one.
   *
   * Absent means a `fill` action is refused rather than ignored: an agent that
   * silently skips filling a password reports success on a login it never
   * completed, and then acts as though it were signed in.
   */
  readonly secrets?: SecretSource;
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

  readonly #secrets: SecretSource | undefined;
  /**
   * Values filled this session, so extracted text can be scrubbed of them.
   *
   * Held here rather than asked of the vault again: re-reading a secret to check
   * whether it leaked would mean decrypting it on a path that has nothing to do
   * with filling it, which is one more place it exists in memory.
   */
  readonly #filled = new Map<string, string[]>();

  constructor(options: ExecutorOptions) {
    this.#driver = options.driver;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
    this.#secrets = options.secrets;
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
   * Resolve every `fill` in a batch, and hand back what is left to run.
   *
   * The order inside is the security property, and it is worth reading as an
   * order rather than as a list:
   *
   *   1. the origin is read from the **live session**, not from the action, not
   *      from the model, not from a caller's belief about where it is;
   *   2. the vault refuses unless that origin is on the item's own allowlist;
   *   3. only then is anything decrypted;
   *   4. the value goes straight to the driver and nowhere else;
   *   5. the session is tainted before the next action runs, so the very next
   *      screenshot is already masked.
   *
   * Step 3 after step 2 matters more than it looks: decrypting first and
   * checking afterwards puts a plaintext password in memory on a path that was
   * about to be refused, and every accident downstream starts there.
   */
  async #fillSecrets(
    scope: AccessScope,
    sessionId: string,
    actions: readonly BrowserAction[],
    taint: TaintState
  ): Promise<
    | { readonly ok: true; readonly taint: TaintState; readonly rest: readonly BrowserAction[] }
    | { readonly ok: false; readonly reason: string; readonly refusedAt: number }
  > {
    if (!this.#secrets) {
      return {
        ok: false,
        refusedAt: actions.findIndex((action) => action.action === "fill"),
        reason: "No vault is configured, so I have no saved credentials to use.",
      };
    }

    let next = taint;
    const rest: BrowserAction[] = [];

    for (const [index, action] of actions.entries()) {
      if (action.action !== "fill") {
        rest.push(action);
        continue;
      }

      // Read from the session every time, because a page can navigate between
      // one action and the next.
      const origin = await this.#driver.currentOrigin(scope, sessionId);
      const revealed = await this.#secrets.reveal(scope, action.itemId, origin, action.field);

      if (!revealed.ok) return { ok: false, reason: revealed.reason, refusedAt: index };

      const { selector } = await this.#driver.fillSecret(
        scope,
        sessionId,
        action.target,
        revealed.value
      );

      /**
       * A field that could not be marked is a field that cannot be masked.
       *
       * The session is tainted regardless — the secret is on the page either
       * way — but captures are refused rather than taken unmasked, because a
       * screenshot with a visible password is worse than no screenshot.
       */
      next = markFilled(next, origin, [selector || UNMASKABLE]);

      const values = this.#filled.get(sessionId) ?? [];
      values.push(revealed.value);
      this.#filled.set(sessionId, values);

      const filled: AuditAction = "vault.fill";
      await this.#audit?.record({
        workspaceId: scope.workspaceId,
        action: filled,
        subject: sessionId,
        // The item and the place it went, never the value. An audit log that
        // records secrets is a second copy of the vault with no encryption.
        detail: { itemId: action.itemId, field: action.field, origin },
        at: this.#now().toISOString(),
      });
    }

    return { ok: true, taint: next, rest };
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

    /**
     * Credentials go in before the rest of the batch, and never through it.
     *
     * A `fill` is removed from the actions the driver is given, because the
     * driver has no vault and must not be able to resolve one — a driver that
     * could would be a route around everything below. What it gets is a value
     * this layer has already decided may exist on this page.
     *
     * Done before the batch rather than in the middle of it for the same reason
     * the batch is authorised whole: a login half-filled is a state nobody can
     * reason about.
     */
    let live = taint;
    let remaining = request;

    if (request.kind === "targeted" && request.actions.some((a) => a.action === "fill")) {
      const outcome = await this.#fillSecrets(scope, sessionId, request.actions, live);
      if (!outcome.ok) {
        await this.#deny(scope, sessionId, "type", outcome.reason);
        return { ok: false, reason: outcome.reason, refusedAt: outcome.refusedAt, taint: live };
      }

      live = outcome.taint;
      this.#taint.set(sessionId, live);
      remaining = { kind: "targeted", actions: outcome.rest };

      // Nothing else was asked for, so the fill was the whole batch.
      if (outcome.rest.length === 0) {
        return {
          ok: true,
          result: { currentOrigin: await this.#driver.currentOrigin(scope, sessionId) },
          taint: live,
        };
      }
    }

    // Masking is derived from live taint, never from a caller's argument, so a
    // capture cannot be taken unmasked by omission.
    const options: DriverOptions = { maskSelectors: live.filledSelectors };

    const result =
      remaining.kind === "targeted"
        ? await this.#driver.perform(scope, sessionId, remaining.actions, options)
        : await this.#driver.performComputer(scope, sessionId, remaining.actions, options);

    /**
     * Belt and braces behind the blocked read paths: even if a secret reaches
     * page text through some route we did not anticipate, it is replaced before
     * the model sees it.
     *
     * `live`, not `taint` — the batch may have just filled a credential, and
     * these two lines used the value from before it. Caught by a test where a
     * fill was followed by a click: the fill alone stayed tainted, and adding
     * one more action silently discarded it. Scrubbing and masking would then
     * have been switched off on precisely the page holding a password.
     */
    const scrubbed = live.tainted ? this.#scrub(result) : result;

    const next = afterNavigation(live, result.currentOrigin);
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
