/**
 * One browser per workspace, kept between tasks.
 *
 * Nell previously opened a browser when a task arrived and closed it when the
 * task ended. That is the obvious shape and it is wrong, for a reason visible
 * within minutes of using the thing: every task began on a blank start page, so
 * the first step of every task was navigating away from it, and any login from
 * the last task was gone. Five tasks against the same site meant five logins.
 *
 * The architecture calls for a persistent machine per workspace precisely
 * because the state *is* the asset — cookies, sessions, and a browser profile
 * that a merchant comes to recognise, so step-up checks get rarer the longer it
 * lives. A session destroyed after every task can never accumulate any of that.
 *
 * This is the smaller half of that design: `MachineRegistry` and `MachineHost`
 * model the full lifecycle (standby, resume, scratch machines, destroy
 * receipts) against the computer-use surface, while the agent loop drives the
 * structured surface through `BrowserProvider`. Holding the session open here
 * gets the compounding benefit today without pretending the two surfaces have
 * been unified — they have not, and doing that properly is its own change.
 *
 * What carries between tasks is the *context* — cookies, storage, logins — and
 * not the page. Each task gets a fresh one. That distinction was learned the
 * hard way: a task ended on a site showing a wall, the next message asked about
 * somewhere else, and the answer came back about the first site, because the
 * first thing the new task saw was the old task's page.
 *
 * Serial by assumption, not by lock: `run()` handles one message at a time, and
 * a workspace has one machine, so two tasks sharing it is a scheduling question
 * the task registry answers rather than something to paper over with a mutex.
 */

import type { BrowserProvider, BrowserSession } from "@nell/browser";
import type { AccessScope } from "@nell/shared";

export interface SessionPoolOptions {
  readonly provider: BrowserProvider;
  /** Where a workspace's browser opens the very first time, and never again. */
  readonly startUrl?: string;
}

/**
 * The scope is kept with the session rather than reconstructed at close time.
 * Inventing a principal — a `userId: "system"` good enough to satisfy an
 * ownership check — is how ownership checks stop meaning anything, and this
 * codebase spends a lot of effort making them mean something.
 */
interface Held {
  readonly scope: AccessScope;
  readonly session: BrowserSession;
}

export class WorkspaceSessions {
  readonly #provider: BrowserProvider;
  readonly #startUrl: string | undefined;
  readonly #sessions = new Map<string, Held>();

  constructor(options: SessionPoolOptions) {
    this.#provider = options.provider;
    this.#startUrl = options.startUrl;
  }

  /**
   * The workspace's browser, opening one if this is the first task.
   *
   * A session can die under us — the browser crashes, the machine is swept, a
   * context is closed. That has to be survivable rather than fatal, because the
   * failure lands on whoever happened to send the next message, and "your task
   * failed because a browser we opened yesterday went away" is not their
   * problem. So a dead session is discarded and reopened once; a second failure
   * is real and propagates.
   */
  async acquire(scope: AccessScope): Promise<BrowserSession> {
    const existing = this.#sessions.get(scope.workspaceId);
    if (existing) {
      if (await this.#alive(scope, existing.session)) {
        /**
         * Cookies carry over; the page does not.
         *
         * Keeping the session open is what stops the agent logging in again for
         * every task — but the first thing a new task sees would otherwise be
         * the *last* task's page. Watched live: a task ended on a site showing a
         * wall, the next message asked about somewhere else entirely, and the
         * answer came back about the first site. The agent had never navigated;
         * it was judged on a page left behind.
         */
        await this.#provider.reset?.(scope, existing.session.id);
        return existing.session;
      }
      this.#sessions.delete(scope.workspaceId);
    }

    const session = await this.#provider.createSession(scope, { startUrl: this.#startUrl });
    this.#sessions.set(scope.workspaceId, { scope, session });
    return session;
  }

  /**
   * Whether the session still exists, asked by using it.
   *
   * There is no `isAlive` on the port and adding one would be a worse design:
   * anything it could report would be true at the moment of asking and stale by
   * the time it was acted on. Taking a snapshot is the same question with no
   * gap between answer and use.
   */
  async #alive(scope: AccessScope, session: BrowserSession): Promise<boolean> {
    try {
      await this.#provider.snapshot(scope, session.id);
      return true;
    } catch {
      return false;
    }
  }

  /** Close everything. For shutdown and for tests, not for the end of a task. */
  async close(): Promise<void> {
    const open = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      open.map(async (held) => {
        await this.#provider.destroy(held.scope, held.session.id).catch(() => undefined);
      })
    );
  }
}
