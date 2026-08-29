/**
 * BrowserProvider port.
 *
 * Nell talks to browsers through this narrow interface so the vendor stays
 * swappable: a hosted cloud-browser service in production, a local Chromium
 * sidecar for self-host, both exercised by the same code and the same tests.
 *
 * Session ownership is enforced above this layer — every call is made with a
 * resolved AccessScope, and a session that does not belong to that workspace is
 * not found.
 */

import type { AccessScope } from "@nell/shared";
import type { CaptureOptions } from "./adapters/computer-exec.js";
import type { ComputerAction, CoordinateSpace } from "./computer.js";
import type { BrowserAction } from "./dsl.js";

export interface BrowserSession {
  readonly id: string;
  readonly workspaceId: string;
  /** Persistent profile this session was launched with, when reused. */
  readonly profileId?: string;
  /** URL a human can open to watch or take over. */
  readonly liveViewUrl?: string;
}

export interface CreateSessionOptions {
  /**
   * Reusing a per-merchant profile keeps cookies and logins alive between
   * tasks, so a repeat booking does not re-authenticate from scratch.
   */
  readonly profileId?: string;
  readonly startUrl?: string;
  readonly timeoutSeconds?: number;
}

export interface ActionResult {
  /** Origin the page is on AFTER the batch — the origin gate reads this. */
  readonly currentOrigin: string;
  /** Extracted values, when the batch contained an extract action. */
  readonly extracted?: Record<string, string>;
  /** Base64 PNG, when the batch contained a screenshot. */
  readonly screenshot?: string;
  /** Where the pointer ended up, in viewport space. */
  readonly cursor?: { readonly x: number; readonly y: number };
}

export interface BrowserProvider {
  createSession(scope: AccessScope, options?: CreateSessionOptions): Promise<BrowserSession>;

  /** Execute a bounded batch of typed actions. Never accepts code. */
  perform(
    scope: AccessScope,
    sessionId: string,
    actions: readonly BrowserAction[],
    options?: CaptureOptions
  ): Promise<ActionResult>;

  /**
   * Execute computer-use actions: pixels, not refs. A co-equal way to drive the
   * same session, not a fallback — a worker may interleave the two freely
   * within one task, and both meet the same policy chokepoint above this layer.
   */
  performComputer(
    scope: AccessScope,
    sessionId: string,
    actions: readonly ComputerAction[],
    options?: CaptureOptions
  ): Promise<ActionResult>;

  /**
   * How the model's screenshot relates to the real screen. Callers need this to
   * tell a model what resolution it is looking at; getting it wrong makes every
   * click land short.
   */
  coordinateSpace(): CoordinateSpace;

  /**
   * The browser's ACTUAL current origin, read from the live session. The origin
   * gate compares this against a vault item's allowlist — the model never gets
   * to assert where it is.
   */
  currentOrigin(scope: AccessScope, sessionId: string): Promise<string>;

  /** Persist cookies/storage for reuse by a later task. */
  saveProfile(scope: AccessScope, sessionId: string, profileId: string): Promise<void>;

  /** Recording of the session, for receipts and dispute evidence. */
  replayUrl(scope: AccessScope, sessionId: string): Promise<string | undefined>;

  destroy(scope: AccessScope, sessionId: string): Promise<void>;
}
