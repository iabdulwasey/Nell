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
}

export interface BrowserProvider {
  createSession(scope: AccessScope, options?: CreateSessionOptions): Promise<BrowserSession>;

  /** Execute a bounded batch of typed actions. Never accepts code. */
  perform(
    scope: AccessScope,
    sessionId: string,
    actions: readonly BrowserAction[]
  ): Promise<ActionResult>;

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
